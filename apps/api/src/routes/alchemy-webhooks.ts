import type { RequestIdVariables } from "hono/request-id";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";

import type { AppRuntime } from "../runtime.js";
import { RequestMeta, requestMetaFrom } from "../http/request-meta.js";
import {
  BASE_MAINNET_NETWORK,
  parseAddressActivity,
} from "../services/alchemy/address-activity.js";
import { AlchemyWebhook } from "../services/alchemy/alchemy-webhook.js";
import { USDC_BASE_ADDRESS } from "../services/chain/base.js";
import { creditUsdcDeposits } from "../services/wallet/deposits.js";

const ACTOR = { type: "system", id: "alchemy-webhook" } as const;

type Outcome =
  | { readonly status: 200 }
  | { readonly status: 400 | 401; readonly reason: string };

/**
 * Alchemy Address Activity deliveries for company wallets on Base. A
 * delivery only names transactions to look at; `creditUsdcDeposits` reads
 * each receipt and credits what actually happened on chain.
 *
 * 200 for anything accepted (credited, ignored or already credited), 401
 * for a bad signature, 400 for malformed JSON, 500 when a receipt or the
 * database is unavailable, so Alchemy retries the delivery.
 */
function handleDelivery(
  rawBody: string,
  signature: string | undefined,
  requestId: string,
) {
  return Effect.gen(function* () {
    const alchemy = yield* AlchemyWebhook;
    if (!alchemy.verifySignature(rawBody, signature)) {
      console.warn(
        `[alchemy-webhook] request ${requestId} rejected: bad signature`,
      );
      return { status: 401, reason: "Invalid signature" } satisfies Outcome;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      console.warn(
        `[alchemy-webhook] request ${requestId} rejected: invalid JSON`,
        error,
      );
      return { status: 400, reason: "Invalid JSON" } satisfies Outcome;
    }

    const event = parseAddressActivity(body);
    if (!event) return { status: 200 } satisfies Outcome;
    if (event.network !== BASE_MAINNET_NETWORK) {
      console.warn(
        `[alchemy-webhook] delivery ${event.id} ignored: network ${event.network}`,
      );
      return { status: 200 } satisfies Outcome;
    }

    const usdc = USDC_BASE_ADDRESS.toLowerCase();
    const reorged = event.activity.filter((activity) => activity.removed);
    if (reorged.length > 0) {
      console.error(
        `[alchemy-webhook] delivery ${event.id} reports reorged transfers; check the ledger`,
        reorged.map((activity) => activity.hash),
      );
    }
    const candidates = event.activity
      .filter(
        (activity) =>
          !activity.removed &&
          activity.category === "token" &&
          activity.contractAddress === usdc,
      )
      .map((activity) => activity.hash);

    const summary = yield* creditUsdcDeposits(candidates, ACTOR);
    if (summary.credited > 0) {
      console.log(
        `[alchemy-webhook] delivery ${event.id} credited ${summary.credited} deposit(s)`,
      );
    }
    return { status: 200 } satisfies Outcome;
  });
}

export function createAlchemyWebhookRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: RequestIdVariables }> {
  return new Hono<{ Variables: RequestIdVariables }>().post(
    "/alchemy",
    async (c) => {
      // The HMAC covers the exact bytes, so read them before parsing.
      const rawBody = await c.req.text();
      const requestId = c.get("requestId");
      const exit = await runtime.runPromiseExit(
        handleDelivery(
          rawBody,
          c.req.header("x-alchemy-signature"),
          requestId,
        ).pipe(Effect.provideService(RequestMeta, requestMetaFrom(c))),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[alchemy-webhook] request ${requestId} failed; Alchemy will retry`,
          Cause.pretty(exit.cause),
        );
        return c.text("Temporarily unavailable", 500);
      }
      const outcome: Outcome = exit.value;
      return outcome.status === 200
        ? c.body(null, 200)
        : c.text(outcome.reason, outcome.status);
    },
  );
}
