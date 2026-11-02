import type { ConfigError } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { z } from "zod";

import type { PaycrestRecipient } from "./recipient.js";

/**
 * Paycrest's v2 Sender API, ported from the consumer backend
 * (`backend/src/services/paycrest/paycrest-client.ts`). Paycrest has no
 * sandbox: tests fake this port, and live checks use small real amounts.
 */

export class PaycrestError extends Data.TaggedError("PaycrestError")<{
  readonly message: string;
  readonly status: number;
  readonly code: string;
  /**
   * The request changed state and may have succeeded although we saw an
   * error (a timeout, a 5xx, an unreadable reply). Never retry blindly.
   */
  readonly ambiguous: boolean;
}> {}

/** Decimal strings, at most 6 places, as USDC and rates use. */
const decimal = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/);

const institutionSchema = z.object({
  code: z.string().min(1),
  name: z.string(),
  type: z.string(),
});
export type PaycrestInstitution = z.infer<typeof institutionSchema>;

const rateSchema = z.object({
  sell: z.object({
    rate: decimal,
    providerIds: z.array(z.string().min(1)).min(1).max(3),
  }),
});
export interface PaycrestRate {
  readonly rate: string;
  readonly providerIds: readonly string[];
}

/** Paycrest's TransactionLog; any status, including ones not seen yet. */
const transactionLogSchema = z.looseObject({
  status: z.string().optional(),
  gateway_id: z.string().nullish(),
  tx_hash: z.string().nullish(),
  created_at: z.string().nullish(),
});

const orderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  direction: z.string().optional(),
  amount: decimal,
  rate: decimal,
  reference: z.string().optional(),
  transactionFee: decimal,
  senderFee: decimal,
  source: z.looseObject({
    type: z.string(),
    currency: z.string(),
    network: z.string(),
    refundAddress: z.string().optional(),
  }),
  destination: z.looseObject({
    type: z.string(),
    currency: z.string(),
    country: z.string().optional(),
    recipient: z.looseObject({
      institution: z.string(),
      accountIdentifier: z.string(),
      accountName: z.string().optional(),
      metadata: z
        .looseObject({
          channel: z.string().optional(),
          businessNumber: z.string().optional(),
        })
        .nullish(),
    }),
  }),
  providerAccount: z
    .looseObject({
      network: z.string(),
      receiveAddress: z.string(),
      validUntil: z.string(),
      amountToTransfer: decimal,
      currency: z.string(),
      memo: z.string().nullish(),
    })
    .nullish(),
  amountReturned: decimal.optional(),
  txHash: z.string().nullish(),
  /** The payout receipt, e.g. the M-Pesa code; null until paid. */
  paymentReference: z.string().nullish(),
  /**
   * The order's on-chain steps, each with the Gateway's order ID once it
   * has one. Only used to link Gateway refunds, so logs this can't read are
   * dropped (`null`) instead of failing the whole order.
   */
  transactionLogs: z
    .array(transactionLogSchema)
    .nullable()
    .catch(null)
    .optional(),
});
export type PaycrestOrder = z.infer<typeof orderSchema>;

export interface PaycrestOrderRequest {
  readonly amount: string;
  readonly amountIn: "crypto";
  readonly rate: string;
  readonly reference: string;
  /** With no Expendi fee, the deposit is `amount + transactionFee` either way. */
  readonly transactionFeePayer: "customer";
  readonly source: {
    readonly type: "crypto";
    readonly currency: "USDC";
    readonly network: "base";
    readonly refundAddress: string;
  };
  readonly destination: {
    readonly type: "fiat";
    readonly currency: "KES";
    readonly country: "KE";
    readonly providerIds: readonly string[];
    readonly recipient: PaycrestRecipient;
  };
}

export interface PaycrestShape {
  /** Sell rate for `usdcAmount` of USDC on Base into KES. */
  readonly rate: (
    usdcAmount: string,
  ) => Effect.Effect<PaycrestRate, PaycrestError>;
  readonly institutions: () => Effect.Effect<
    readonly PaycrestInstitution[],
    PaycrestError
  >;
  /** The registered account name, or "OK" when the corridor returns none. */
  readonly verifyAccount: (
    recipient: Pick<
      PaycrestRecipient,
      "institution" | "accountIdentifier" | "metadata"
    >,
  ) => Effect.Effect<string, PaycrestError>;
  readonly createOrder: (
    request: PaycrestOrderRequest,
  ) => Effect.Effect<PaycrestOrder, PaycrestError>;
  readonly getOrder: (
    id: string,
  ) => Effect.Effect<PaycrestOrder, PaycrestError>;
  /** Checks `X-Paycrest-Signature`: hex HMAC-SHA256 of the raw body. */
  readonly verifyWebhookSignature: (
    rawBody: string,
    signature: string | undefined,
  ) => boolean;
}

export class Paycrest extends Context.Tag("Paycrest")<
  Paycrest,
  PaycrestShape
>() {}

export interface PaycrestSettings {
  readonly apiKey: Redacted.Redacted;
  /** Signs webhooks. */
  readonly apiSecret: Redacted.Redacted;
  readonly baseUrl: string;
}

/**
 * Paycrest's documented scheme: HMAC-SHA256 of the exact body with the API
 * secret, as lowercase hex; compare the hex strings in constant time.
 */
export function verifyPaycrestSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  const given = signature?.trim().toLowerCase();
  if (!secret.trim() || !given || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret.trim())
    .update(rawBody, "utf8")
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(given, "utf8"),
  );
}

const REQUEST_TIMEOUT_MS = 20_000;

export function makePaycrest(
  settings: PaycrestSettings,
  fetchImpl: typeof fetch = fetch,
): PaycrestShape {
  const request = <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Effect.Effect<T, PaycrestError> => {
    const changesState = body !== undefined;
    const fail = (status: number, code: string, ambiguous: boolean) =>
      new PaycrestError({
        message: `Paycrest ${changesState ? "POST" : "GET"} ${path.split("?")[0] ?? path}: ${code}`,
        status,
        code,
        ambiguous,
      });
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${settings.baseUrl.replace(/\/$/, "")}${path}`, {
            method: changesState ? "POST" : "GET",
            headers: {
              "API-Key": Redacted.value(settings.apiKey),
              "Content-Type": "application/json",
            },
            ...(changesState && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => fail(503, "TRANSPORT_ERROR", changesState),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          fail(
            response.status,
            `HTTP_${response.status}`,
            changesState && response.status >= 500,
          ),
        );
      }
      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ data?: unknown }>,
        catch: () => fail(502, "INVALID_RESPONSE", changesState),
      });
      const parsed = schema.safeParse(payload.data);
      return parsed.success
        ? parsed.data
        : yield* Effect.fail(fail(502, "INVALID_RESPONSE", changesState));
    });
  };

  return {
    rate: (usdcAmount) =>
      request(
        `/rates/base/USDC/${encodeURIComponent(usdcAmount)}/KES?side=sell`,
        rateSchema,
      ).pipe(Effect.map(({ sell }) => sell)),
    institutions: () =>
      request("/institutions/KES", z.array(institutionSchema)),
    verifyAccount: (recipient) =>
      request("/verify-account", z.string(), recipient),
    createOrder: (orderRequest) =>
      request("/sender/orders", orderSchema, orderRequest),
    getOrder: (id) =>
      request(`/sender/orders/${encodeURIComponent(id)}`, orderSchema),
    verifyWebhookSignature: (rawBody, signature) =>
      verifyPaycrestSignature(
        rawBody,
        signature,
        Redacted.value(settings.apiSecret),
      ),
  };
}

export const PaycrestLive: Layer.Layer<Paycrest, ConfigError.ConfigError> =
  Layer.effect(
    Paycrest,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("PAYCREST_API_KEY");
      const apiSecret = yield* Config.redacted("PAYCREST_API_SECRET");
      const baseUrl = yield* Config.withDefault(
        Config.string("PAYCREST_BASE_URL"),
        "https://api.paycrest.io/v2",
      );
      return makePaycrest({ apiKey, apiSecret, baseUrl });
    }),
  );
