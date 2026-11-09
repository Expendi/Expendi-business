import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { AppRuntime } from "../runtime.js";
import type { LithicSignatureHeaders } from "../services/lithic/lithic-client.js";
import { RequestMeta, requestMetaFrom } from "../http/request-meta.js";
import { webhookSignatureFailure } from "../services/alerts/alert-checks.js";
import { raiseAlert } from "../services/alerts/ops-alerts.js";
import {
  authorizeCardRequest,
  cardAuthorizationRequestSchema,
} from "../services/cards/authorization.js";
import { applyCardTransaction } from "../services/cards/transactions.js";
import { Lithic } from "../services/lithic/lithic-client.js";

const deliverySchema = z.looseObject({
  event_type: z.string().optional(),
  token: z.string().min(1).optional(),
  card_token: z.string().optional(),
  payload: z.looseObject({ token: z.string().min(1).optional() }).optional(),
});

/** Lithic sends a whole transaction, or an event wrapping one in `payload`. */
function transactionTokenOf(
  delivery: z.infer<typeof deliverySchema>,
): string | null {
  if (
    delivery.event_type !== undefined &&
    delivery.event_type !== "card_transaction.updated"
  ) {
    return null;
  }
  if (delivery.payload?.token) return delivery.payload.token;
  return delivery.card_token !== undefined && delivery.token
    ? delivery.token
    : null;
}

type Outcome =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401; readonly body: { readonly error: string } };

function alertBadSignature(requestId: string) {
  return raiseAlert(webhookSignatureFailure("lithic")).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() =>
        console.error(
          `[lithic-webhook] request ${requestId}: alert not recorded`,
          error.message,
        ),
      ),
    ),
  );
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    console.warn("[lithic-webhook] invalid JSON", error);
    return undefined;
  }
}

const badSignature = {
  status: 401,
  body: { error: "Invalid signature" },
} satisfies Outcome;

/**
 * An event only says which transaction changed. It's re-fetched from Lithic
 * and applied by `applyCardTransaction`, which works from Lithic's current
 * state, so duplicates and replays change nothing.
 */
function handleEvent(
  rawBody: string,
  headers: LithicSignatureHeaders,
  requestId: string,
) {
  return Effect.gen(function* () {
    const lithic = yield* Lithic;
    if (!lithic.verifyEventSignature(rawBody, headers)) {
      console.warn(
        `[lithic-webhook] request ${requestId} rejected: bad signature`,
      );
      yield* alertBadSignature(requestId);
      return badSignature;
    }
    const delivery = deliverySchema.safeParse(parseJson(rawBody));
    if (!delivery.success) {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const token = transactionTokenOf(delivery.data);
    if (token === null) {
      return { status: 200, body: { ignored: true } } satisfies Outcome;
    }
    const transaction = yield* lithic.getTransaction(token);
    const outcome = yield* applyCardTransaction(transaction);
    return { status: 200, body: { ok: true, ...outcome } } satisfies Outcome;
  });
}

/**
 * Lithic waits for this to decide a card payment. A bad signature or an
 * internal error both end in a decline: Lithic doesn't retry a 4xx and only
 * briefly retries a 5xx before declining, so the path fails closed.
 */
function handleAuthorization(
  rawBody: string,
  headers: LithicSignatureHeaders,
  requestId: string,
) {
  return Effect.gen(function* () {
    const lithic = yield* Lithic;
    if (!lithic.verifyAuthorizationSignature(rawBody, headers)) {
      console.warn(
        `[lithic-webhook] request ${requestId} rejected: bad signature`,
      );
      yield* alertBadSignature(requestId);
      return badSignature;
    }
    const request = cardAuthorizationRequestSchema.safeParse(
      parseJson(rawBody),
    );
    if (!request.success) {
      return {
        status: 400,
        body: { error: "Invalid authorization request" },
      } satisfies Outcome;
    }
    const decision = yield* authorizeCardRequest(request.data);
    return { status: 200, body: { ...decision } } satisfies Outcome;
  });
}

function signatureHeaders(c: Context): LithicSignatureHeaders {
  return {
    id: c.req.header("webhook-id"),
    timestamp: c.req.header("webhook-timestamp"),
    signature: c.req.header("webhook-signature"),
  };
}

/** Mounted at `/webhooks`: `/lithic` events and `/lithic/authorization`. */
export function createLithicWebhookRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: RequestIdVariables }> {
  return new Hono<{ Variables: RequestIdVariables }>()
    .use("*", bodyLimit({ maxSize: 64 * 1024 }))
    .post("/lithic", async (c) => {
      // The signature covers the exact bytes, so read them before parsing.
      const rawBody = await c.req.text();
      const requestId = c.get("requestId");
      const exit = await runtime.runPromiseExit(
        handleEvent(rawBody, signatureHeaders(c), requestId).pipe(
          Effect.provideService(RequestMeta, requestMetaFrom(c)),
        ),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[lithic-webhook] request ${requestId} failed; Lithic will retry`,
          Cause.pretty(exit.cause),
        );
        return c.json({ error: "Temporarily unavailable" }, 500);
      }
      return c.json(exit.value.body, exit.value.status);
    })
    .post("/lithic/authorization", async (c) => {
      const rawBody = await c.req.text();
      const requestId = c.get("requestId");
      const exit = await runtime.runPromiseExit(
        handleAuthorization(rawBody, signatureHeaders(c), requestId).pipe(
          Effect.provideService(RequestMeta, requestMetaFrom(c)),
        ),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[lithic-webhook] authorization ${requestId} failed; fails closed`,
          Cause.pretty(exit.cause),
        );
        return c.json({ error: "Temporarily unavailable" }, 500);
      }
      return c.json(exit.value.body, exit.value.status);
    });
}
