import type { RequestIdVariables } from "hono/request-id";
import { Cause, Data, Effect, Exit } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { AppRuntime } from "../runtime.js";
import { RequestMeta, requestMetaFrom } from "../http/request-meta.js";
import { webhookSignatureFailure } from "../services/alerts/alert-checks.js";
import { raiseAlert } from "../services/alerts/ops-alerts.js";
import {
  payoutForPretiumTransaction,
  syncPretiumPayout,
} from "../services/payout/pretium-sync.js";
import { Pretium } from "../services/pretium/pretium-client.js";

/**
 * A callback names a transaction and claims a status. Only the name is
 * used: the status is read again from Pretium by `syncPretiumPayout`.
 */
const callbackSchema = z.object({
  transaction_code: z.string().min(1),
  is_released: z.unknown().optional(),
});

type Outcome =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401; readonly body: { readonly error: string } };

/** The callback can't be judged now; the minute job will. */
class PretiumStatusUnavailable extends Data.TaggedError(
  "PretiumStatusUnavailable",
)<{ readonly transactionCode: string; readonly code: string }> {}

/**
 * Callbacks aren't guaranteed to arrive or be retried, so the minute job
 * is the source of truth and a callback only brings its check forward.
 * The sync only moves a payout forward, so replays change nothing. This
 * route reaches only the read-only sync: it never sends, pays or refunds.
 */
function handleCallback(
  rawBody: string,
  signature: string | undefined,
  requestId: string,
) {
  return Effect.gen(function* () {
    const pretium = yield* Pretium;
    if (!pretium.verifyWebhookSignature(rawBody, signature)) {
      console.warn(
        `[pretium-webhook] request ${requestId} rejected: bad signature`,
      );
      yield* raiseAlert(webhookSignatureFailure("pretium")).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() =>
            console.error(
              `[pretium-webhook] request ${requestId}: alert not recorded`,
              error.message,
            ),
          ),
        ),
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
        `[pretium-webhook] request ${requestId} rejected: invalid JSON`,
        error,
      );
      return { status: 400, body: { error: "Invalid JSON" } } satisfies Outcome;
    }
    const callback = callbackSchema.safeParse(payload);
    // A release callback reports crypto Pretium sent out, never a cash-out.
    if (!callback.success || callback.data.is_released !== undefined) {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const code = callback.data.transaction_code;

    // The account is shared with another product, whose transactions
    // arrive here too.
    const payout = yield* payoutForPretiumTransaction(code);
    if (!payout) {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const synced = yield* syncPretiumPayout({
      organizationId: payout.organization_id,
      payoutId: payout.payout_id,
      source: "webhook",
    });
    if (synced.statusError) {
      return yield* Effect.fail(
        new PretiumStatusUnavailable({
          transactionCode: code,
          code: synced.statusError.code,
        }),
      );
    }
    return {
      status: 200,
      body: { ok: true, ...synced.outcome },
    } satisfies Outcome;
  });
}

export function createPretiumWebhookRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: RequestIdVariables }> {
  return new Hono<{ Variables: RequestIdVariables }>()
    .use("*", bodyLimit({ maxSize: 64 * 1024 }))
    .post("/pretium", async (c) => {
      // The HMAC covers the exact bytes, so read them before parsing.
      const rawBody = await c.req.text();
      const requestId = c.get("requestId");
      const exit = await runtime.runPromiseExit(
        handleCallback(
          rawBody,
          c.req.header("x-signature-key"),
          requestId,
        ).pipe(Effect.provideService(RequestMeta, requestMetaFrom(c))),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[pretium-webhook] request ${requestId} failed; the minute job will settle it`,
          Cause.pretty(exit.cause),
        );
        return c.json({ error: "Temporarily unavailable" }, 500);
      }
      return c.json(exit.value.body, exit.value.status);
    });
}
