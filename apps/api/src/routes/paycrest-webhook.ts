import type { RequestIdVariables } from "hono/request-id";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { AppRuntime } from "../runtime.js";
import { RequestMeta, requestMetaFrom } from "../http/request-meta.js";
import { Paycrest } from "../services/paycrest/paycrest-client.js";
import { payoutForOrder, syncPayoutOrder } from "../services/payout/sync.js";

/**
 * Real deliveries carry `webhookVersion: "1"` and no `data.direction`; the
 * consumer backend ignored every one by requiring v2 (its unmerged fix
 * `fix/paycrest-webhook-v1`). So: any version, direction optional.
 */
const deliverySchema = z.object({
  event: z.string().startsWith("payment_order."),
  data: z.object({
    id: z.string().min(1),
    direction: z.string().optional(),
  }),
});

type Outcome =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401; readonly body: { readonly error: string } };

/**
 * A delivery only says which order changed. The order is re-fetched from
 * Paycrest and applied by `syncPayoutOrder`, which only moves a payout
 * forward, so duplicates and replays change nothing.
 */
function handleDelivery(
  rawBody: string,
  signature: string | undefined,
  requestId: string,
) {
  return Effect.gen(function* () {
    const paycrest = yield* Paycrest;
    if (!paycrest.verifyWebhookSignature(rawBody, signature)) {
      console.warn(
        `[paycrest-webhook] request ${requestId} rejected: bad signature`,
      );
      return {
        status: 401,
        body: { error: "Invalid signature" },
      } satisfies Outcome;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch (error) {
      console.warn(
        `[paycrest-webhook] request ${requestId} rejected: invalid JSON`,
        error,
      );
      return { status: 400, body: { error: "Invalid JSON" } } satisfies Outcome;
    }
    const delivery = deliverySchema.safeParse(payload);
    if (!delivery.success) {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const { id: orderId, direction } = delivery.data.data;
    if (direction !== undefined && direction !== "offramp") {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }

    const payout = yield* payoutForOrder(orderId);
    if (!payout) {
      console.warn(
        `[paycrest-webhook] ${delivery.data.event} for unknown order ${orderId}`,
      );
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const order = yield* paycrest.getOrder(orderId);
    const outcome = yield* syncPayoutOrder({
      organizationId: payout.organization_id,
      payoutId: payout.payout_id,
      order,
      source: "webhook",
      touch: false,
    });
    return { status: 200, body: { ok: true, ...outcome } } satisfies Outcome;
  });
}

export function createPaycrestWebhookRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: RequestIdVariables }> {
  return new Hono<{ Variables: RequestIdVariables }>()
    .use("*", bodyLimit({ maxSize: 64 * 1024 }))
    .post("/paycrest", async (c) => {
      // The HMAC covers the exact bytes, so read them before parsing.
      const rawBody = await c.req.text();
      const requestId = c.get("requestId");
      const exit = await runtime.runPromiseExit(
        handleDelivery(
          rawBody,
          c.req.header("x-paycrest-signature"),
          requestId,
        ).pipe(Effect.provideService(RequestMeta, requestMetaFrom(c))),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[paycrest-webhook] request ${requestId} failed; Paycrest will retry`,
          Cause.pretty(exit.cause),
        );
        return c.json({ error: "Temporarily unavailable" }, 500);
      }
      return c.json(exit.value.body, exit.value.status);
    });
}
