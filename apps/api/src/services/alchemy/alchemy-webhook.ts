import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";

import {
  parseSigningKeys,
  verifyAlchemySignature,
} from "./address-activity.js";

/**
 * Alchemy's Notify API, used to add addresses to the webhook:
 * PATCH /update-webhook-addresses with `X-Alchemy-Token`.
 */
const ALCHEMY_NOTIFY_API = "https://dashboard.alchemy.com/api";
const NOTIFY_TIMEOUT_MS = 15_000;

export class AlchemyNotifyError extends Data.TaggedError("AlchemyNotifyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Expendi's Address Activity webhook on Base: verifies its deliveries and
 * keeps it watching every company wallet.
 */
export interface AlchemyWebhookShape {
  readonly verifySignature: (
    rawBody: string,
    signature: string | undefined,
  ) => boolean;
  /** Idempotent on Alchemy's side: re-adding a watched address is a no-op. */
  readonly watchAddresses: (
    addresses: readonly string[],
  ) => Effect.Effect<void, AlchemyNotifyError>;
}

export class AlchemyWebhook extends Context.Tag("AlchemyWebhook")<
  AlchemyWebhook,
  AlchemyWebhookShape
>() {}

export interface AlchemyWebhookSettings {
  readonly webhookId: string;
  readonly signingKeys: Redacted.Redacted;
  readonly notifyToken: Redacted.Redacted;
}

export function makeAlchemyWebhook(
  settings: AlchemyWebhookSettings,
  fetchImpl: typeof fetch = fetch,
): AlchemyWebhookShape {
  const keys = parseSigningKeys(Redacted.value(settings.signingKeys));
  return {
    verifySignature: (rawBody, signature) =>
      verifyAlchemySignature(rawBody, signature, keys),
    watchAddresses: (addresses) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(
            `${ALCHEMY_NOTIFY_API}/update-webhook-addresses`,
            {
              method: "PATCH",
              headers: {
                "X-Alchemy-Token": Redacted.value(settings.notifyToken),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                webhook_id: settings.webhookId,
                addresses_to_add: addresses,
                addresses_to_remove: [],
              }),
              signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
            },
          );
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
          }
        },
        catch: (cause) =>
          new AlchemyNotifyError({
            message: "Failed to add addresses to the Alchemy webhook",
            cause,
          }),
      }),
  };
}

export const AlchemyWebhookLive: Layer.Layer<
  AlchemyWebhook,
  ConfigError.ConfigError
> = Layer.effect(
  AlchemyWebhook,
  Effect.gen(function* () {
    const webhookId = yield* Config.string("ALCHEMY_WEBHOOK_ID");
    const signingKeys = yield* Config.redacted("ALCHEMY_WEBHOOK_SIGNING_KEY");
    const notifyToken = yield* Config.redacted("ALCHEMY_NOTIFY_TOKEN");
    return makeAlchemyWebhook({ webhookId, signingKeys, notifyToken });
  }),
);
