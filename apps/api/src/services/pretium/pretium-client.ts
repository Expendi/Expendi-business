import type { ConfigError } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

import { toMicro } from "../paycrest/amounts.js";

/**
 * Pretium's KES disbursement API, a cash-out provider next to Paycrest.
 * Pretium has no sandbox and every endpoint is a POST: tests fake this port.
 *
 * Unlike Paycrest, the USDC reaches Pretium on Base before `pay` is called,
 * so `pay` and `refund` say exactly whether Pretium refused (safe to refund
 * or report failed) or may have acted (reconcile, never assume).
 */

export class PretiumError extends Data.TaggedError("PretiumError")<{
  readonly message: string;
  readonly status: number;
  readonly code: string;
  /**
   * The request may have taken effect although we saw an error (a timeout,
   * a 5xx, an unreadable reply). Never retry blindly.
   */
  readonly ambiguous: boolean;
}> {}

export type PretiumRecipient =
  | {
      readonly type: "MOBILE";
      /** The M-Pesa number without "+", e.g. 254712345678. */
      readonly shortcode: string;
      readonly mobileNetwork: "Safaricom";
    }
  | { readonly type: "BUY_GOODS"; readonly shortcode: string }
  | {
      readonly type: "PAYBILL";
      readonly shortcode: string;
      readonly accountNumber: string;
    }
  | {
      readonly type: "BANK_TRANSFER";
      readonly accountNumber: string;
      /** Pretium's own code for the bank, not the code payees store. */
      readonly bankCode: string;
    };

export interface PretiumPayRequest {
  readonly recipient: PretiumRecipient;
  /** Pretium only pays whole shillings. */
  readonly amountShillings: bigint;
  /** The Base USDC transfer to Pretium that funds this cash-out. */
  readonly transactionHash: string;
  /** The payout's ID, echoed back in callbacks. */
  readonly reference: string;
}

export interface PretiumPayAccepted {
  readonly transactionCode: string;
  readonly status: string;
}

export interface PretiumTransaction {
  readonly transactionCode: string;
  /** As Pretium sends it: PENDING, COMPLETE, FAILED, REVERSED, … */
  readonly status: string;
  readonly amount: string | null;
  /** The M-Pesa or bank receipt, once paid. */
  readonly receiptNumber: string | null;
  readonly publicName: string | null;
  /** Lowercased. */
  readonly transactionHash: string | null;
  readonly message: string | null;
}

export interface PretiumRefund {
  /** Lowercased; null when Pretium doesn't say. */
  readonly refundTxHash: string | null;
  readonly amount: string | null;
  readonly token: string | null;
  readonly address: string | null;
}

export interface PretiumBank {
  readonly code: string;
  readonly name: string;
}

export interface PretiumShape {
  /** False when PRETIUM_API_KEY isn't set: every call then fails. */
  readonly configured: boolean;
  readonly signingKeyConfigured: boolean;
  /** Where Pretium should report a cash-out's outcome, when configured. */
  readonly callbackUrl: string | null;
  /** KES per USDC, as a decimal string. */
  readonly rate: () => Effect.Effect<string, PretiumError>;
  /** Pretium's Base USDC settlement wallet as its API reports it, lowercased. */
  readonly baseSettlementAddress: () => Effect.Effect<string, PretiumError>;
  readonly banks: () => Effect.Effect<readonly PretiumBank[], PretiumError>;
  /** Never retried here: see `PretiumError.ambiguous`. */
  readonly pay: (
    request: PretiumPayRequest,
  ) => Effect.Effect<PretiumPayAccepted, PretiumError>;
  readonly status: (
    transactionCode: string,
  ) => Effect.Effect<PretiumTransaction, PretiumError>;
  /**
   * The transaction Pretium made for the USDC transfer `txHash`, or null if
   * none was made in the days since `since`.
   */
  readonly findByHash: (query: {
    readonly txHash: string;
    readonly since: Date;
  }) => Effect.Effect<PretiumTransaction | null, PretiumError>;
  /** Asks Pretium to send back the USDC of a transfer it didn't pay out. */
  readonly refund: (
    txHash: string,
  ) => Effect.Effect<PretiumRefund, PretiumError>;
  /** Checks `x-signature-key`: hex HMAC-SHA512 of the raw body. */
  readonly verifyWebhookSignature: (
    rawBody: string,
    signature: string | undefined,
  ) => boolean;
}

export class Pretium extends Context.Tag("Pretium")<Pretium, PretiumShape>() {}

export interface PretiumSettings {
  readonly apiKey: Redacted.Redacted | null;
  readonly baseUrl: string;
  readonly signingKey: Redacted.Redacted | null;
  readonly callbackUrl: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export const PRETIUM_DEFAULT_BASE_URL = "https://api.xwift.africa";

const REQUEST_TIMEOUT_MS = 20_000;

/** Pretium answers a transaction listing for at most 3 days at a time. */
const SEARCH_WINDOW_DAYS = 3;
const MAX_SEARCH_WINDOWS = 10;
const DAY_MS = 86_400_000;

const DECIMAL_6 = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const HMAC_SHA512_HEX = /^[0-9a-f]{128}$/;
/** Pretium's refusal when a transaction hash was used before. */
const ALREADY_PROCESSED = /already been processed/i;

export function verifyPretiumSignature(
  rawBody: string,
  signature: string | undefined,
  signingKey: string,
): boolean {
  const given = signature?.trim().toLowerCase();
  if (!signingKey.trim() || !given || !HMAC_SHA512_HEX.test(given)) {
    return false;
  }
  const expected = createHmac("sha512", signingKey.trim())
    .update(rawBody, "utf8")
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(given, "utf8"),
  );
}

/** Pretium sends some amounts as JSON numbers; money stays a string here. */
const numberish = z.union([z.string(), z.number()]);
/**
 * KES per USDC, cut to 6 decimals: a rate rounded down only makes Expendi
 * send slightly more USDC for the same shillings, never less.
 */
const rateValue = numberish
  .transform((value) => String(value).replace(/^(\d+\.\d{6})\d+$/, "$1"))
  .pipe(z.string().regex(DECIMAL_6));
const optionalText = z.string().nullish().catch(null);

const rateSchema = z.object({
  quoted_rate: rateValue.nullish(),
  buying_rate: rateValue.nullish(),
});

const accountSchema = z.object({
  networks: z.array(
    z.looseObject({
      name: z.string().nullish().catch(null),
      settlement_wallet_address: z.string().nullish().catch(null),
      assets: z
        .array(z.looseObject({ name: z.string().nullish().catch(null) }))
        .nullish()
        .catch(null),
    }),
  ),
});

const banksSchema = z.array(
  z.looseObject({
    Code: numberish.transform(String).pipe(z.string().min(1)),
    Name: z.string(),
  }),
);

const transactionSchema = z.looseObject({
  transaction_code: z.string().min(1),
  status: z.string().min(1),
  amount: numberish.transform(String).nullish(),
  receipt_number: z.string().nullish(),
  public_name: z.string().nullish(),
  transaction_hash: z.string().nullish(),
  message: z.string().nullish(),
});

const toTransaction = (
  raw: z.infer<typeof transactionSchema>,
): PretiumTransaction => ({
  transactionCode: raw.transaction_code,
  status: raw.status,
  amount: raw.amount ?? null,
  receiptNumber: raw.receipt_number ?? null,
  publicName: raw.public_name ?? null,
  transactionHash: raw.transaction_hash?.toLowerCase() ?? null,
  message: raw.message ?? null,
});

const payReplySchema = z.object({
  data: z
    .looseObject({
      status: optionalText,
      transaction_code: optionalText,
    })
    .nullish()
    .catch(null),
});

const refundReplySchema = z.object({
  status: optionalText,
  data: z
    .looseObject({
      hash: optionalText,
      amount: numberish.transform(String).nullish().catch(null),
      token: optionalText,
      address: optionalText,
    })
    .nullish()
    .catch(null),
});

function payBody(
  request: PretiumPayRequest,
  callbackUrl: string | null,
): Record<string, unknown> {
  const { recipient } = request;
  const destination = ((): Record<string, string> => {
    switch (recipient.type) {
      case "MOBILE":
        return {
          shortcode: recipient.shortcode,
          mobile_network: recipient.mobileNetwork,
        };
      case "BUY_GOODS":
        return { shortcode: recipient.shortcode };
      case "PAYBILL":
        return {
          shortcode: recipient.shortcode,
          account_number: recipient.accountNumber,
        };
      case "BANK_TRANSFER":
        return {
          account_number: recipient.accountNumber,
          bank_code: recipient.bankCode,
        };
    }
  })();
  return {
    type: recipient.type,
    ...destination,
    amount: Number(request.amountShillings),
    fee: 0,
    // Pretium assumes Celo when the chain is left out.
    chain: "BASE",
    transaction_hash: request.transactionHash,
    ...(callbackUrl !== null && { callback_url: callbackUrl }),
    reference: request.reference,
  };
}

const isoDay = (time: number): string =>
  new Date(time).toISOString().slice(0, 10);

const startOfUtcDay = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface Reply {
  readonly status: number;
  readonly text: string | null;
  /** `undefined` when the body isn't JSON. */
  readonly json: unknown;
}

export function makePretium(settings: PretiumSettings): PretiumShape {
  const fetchImpl = settings.fetch ?? fetch;
  const now = settings.now ?? (() => new Date());
  const { apiKey, signingKey, callbackUrl } = settings;

  const failure = (
    path: string,
    status: number,
    code: string,
    ambiguous: boolean,
  ) =>
    new PretiumError({
      message: `Pretium POST ${path}: ${code}`,
      status,
      code,
      ambiguous,
    });

  /**
   * One POST, never retried. `changesState` marks calls where a lost reply
   * may hide an effect, so only those can be ambiguous.
   */
  const post = (
    path: string,
    body: unknown,
    changesState: boolean,
  ): Effect.Effect<Reply, PretiumError> =>
    Effect.gen(function* () {
      if (apiKey === null) {
        return yield* Effect.fail(failure(path, 503, "NOT_CONFIGURED", false));
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${settings.baseUrl.replace(/\/$/, "")}${path}`, {
            method: "POST",
            headers: {
              "x-api-key": Redacted.value(apiKey),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => failure(path, 503, "TRANSPORT_ERROR", changesState),
      });
      const text = yield* Effect.promise(() =>
        response.text().then(
          (value) => value,
          () => null,
        ),
      );
      return { status: response.status, text, json: parseJson(text) };
    });

  /** A read: any failure is definite, since nothing changed. */
  const read = <T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Effect.Effect<T, PretiumError> =>
    Effect.flatMap(post(path, body, false), (reply) => {
      if (reply.status < 200 || reply.status >= 300) {
        return Effect.fail(
          failure(path, reply.status, `HTTP_${reply.status}`, false),
        );
      }
      const parsed = z.object({ data: schema }).safeParse(reply.json ?? null);
      return parsed.success
        ? Effect.succeed(parsed.data.data)
        : Effect.fail(failure(path, 502, "INVALID_RESPONSE", false));
    });

  /** A definite no; a reused hash gets its own code, since the earlier call landed. */
  const refusal = (path: string, reply: Reply, code: string) =>
    reply.text !== null && ALREADY_PROCESSED.test(reply.text)
      ? failure(path, reply.status, "HASH_ALREADY_PROCESSED", false)
      : failure(path, reply.status, code, false);

  /**
   * The failure for a state-changing call that didn't plainly succeed, or
   * null when the reply is a 2xx JSON body for the caller to judge.
   */
  const unsuccessful = (path: string, reply: Reply): PretiumError | null => {
    if (reply.status >= 500) {
      return failure(path, reply.status, `HTTP_${reply.status}`, true);
    }
    if (reply.status < 200 || reply.status >= 300) {
      return refusal(path, reply, `HTTP_${reply.status}`);
    }
    if (reply.json === undefined) {
      return failure(path, 502, "INVALID_RESPONSE", true);
    }
    return null;
  };

  return {
    configured: apiKey !== null,
    signingKeyConfigured: signingKey !== null,
    callbackUrl,

    rate: () =>
      read("/v1/exchange-rate", { currency_code: "KES" }, rateSchema).pipe(
        Effect.flatMap((data) => {
          const rate = data.quoted_rate ?? data.buying_rate;
          return rate && toMicro(rate) > 0n
            ? Effect.succeed(rate)
            : Effect.fail(
                failure("/v1/exchange-rate", 502, "INVALID_RESPONSE", false),
              );
        }),
      ),

    baseSettlementAddress: () =>
      read("/account/detail", {}, accountSchema).pipe(
        Effect.flatMap(({ networks }) => {
          const address = networks
            .find(
              (network) =>
                network.name?.toLowerCase() === "base" &&
                (network.assets ?? []).some(
                  (asset) => asset.name?.toUpperCase() === "USDC",
                ),
            )
            ?.settlement_wallet_address?.toLowerCase();
          return address && EVM_ADDRESS.test(address)
            ? Effect.succeed(address)
            : Effect.fail(
                failure(
                  "/account/detail",
                  502,
                  "NO_BASE_SETTLEMENT_ADDRESS",
                  false,
                ),
              );
        }),
      ),

    banks: () =>
      read("/v1/banks/KES", {}, banksSchema).pipe(
        Effect.map((banks) =>
          banks.map((bank) => ({ code: bank.Code, name: bank.Name })),
        ),
      ),

    pay: (request) => {
      const path = "/v1/pay/KES";
      const amount = request.amountShillings;
      if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        return Effect.fail(failure(path, 400, "INVALID_REQUEST", false));
      }
      return Effect.flatMap(
        post(path, payBody(request, callbackUrl), true),
        (reply) => {
          const failed = unsuccessful(path, reply);
          if (failed) return Effect.fail(failed);
          const data = payReplySchema.safeParse(reply.json).data?.data;
          if (data?.status?.toUpperCase() === "FAILED") {
            return Effect.fail(refusal(path, reply, "PAY_FAILED"));
          }
          if (!data?.transaction_code) {
            return Effect.fail(refusal(path, reply, "NO_TRANSACTION_CODE"));
          }
          return Effect.succeed({
            transactionCode: data.transaction_code,
            status: data.status ?? "PENDING",
          });
        },
      );
    },

    status: (transactionCode) =>
      read(
        "/v1/status/KES",
        { transaction_code: transactionCode },
        transactionSchema,
      ).pipe(Effect.map(toTransaction)),

    findByHash: ({ txHash, since }) => {
      const path = "/v1/transactions/KES";
      const wanted = txHash.toLowerCase();
      // Pretium's days may run on Kenyan time, ahead of UTC: search to
      // tomorrow so a transfer made late in the UTC day isn't missed.
      const lastDay = startOfUtcDay(now()) + DAY_MS;
      const firstDay = Math.min(startOfUtcDay(since), lastDay);
      const windows: { start_date: string; end_date: string }[] = [];
      for (
        let day = firstDay;
        day <= lastDay;
        day += SEARCH_WINDOW_DAYS * DAY_MS
      ) {
        windows.push({
          start_date: isoDay(day),
          end_date: isoDay(
            Math.min(day + (SEARCH_WINDOW_DAYS - 1) * DAY_MS, lastDay),
          ),
        });
      }
      // Not finding it in part of the range would read as "never made".
      if (windows.length > MAX_SEARCH_WINDOWS) {
        return Effect.fail(failure(path, 400, "SEARCH_RANGE_TOO_LONG", false));
      }
      return Effect.gen(function* () {
        for (const window of windows) {
          const listed = yield* read(
            path,
            window,
            z.array(z.unknown()).nullable(),
          );
          // The account is shared with another product: match on the hash
          // alone, and only insist on reading the transaction that matches.
          const match = (listed ?? []).find((item) => {
            const hash = z
              .object({ transaction_hash: z.string() })
              .safeParse(item).data?.transaction_hash;
            return hash?.toLowerCase() === wanted;
          });
          if (match === undefined) continue;
          const parsed = transactionSchema.safeParse(match);
          return parsed.success
            ? toTransaction(parsed.data)
            : yield* Effect.fail(failure(path, 502, "INVALID_RESPONSE", false));
        }
        return null;
      });
    },

    refund: (txHash) => {
      const path = "/v1/refund";
      return Effect.flatMap(
        post(path, { chain: "BASE", transaction_hash: txHash }, true),
        (reply) => {
          const failed = unsuccessful(path, reply);
          if (failed) return Effect.fail(failed);
          const parsed = refundReplySchema.safeParse(reply.json).data;
          if (parsed?.status !== "success" && !parsed?.data) {
            return Effect.fail(refusal(path, reply, "REFUND_REFUSED"));
          }
          return Effect.succeed({
            refundTxHash: parsed.data?.hash?.toLowerCase() ?? null,
            amount: parsed.data?.amount ?? null,
            token: parsed.data?.token ?? null,
            address: parsed.data?.address ?? null,
          });
        },
      );
    },

    verifyWebhookSignature: (rawBody, signature) =>
      signingKey !== null &&
      verifyPretiumSignature(rawBody, signature, Redacted.value(signingKey)),
  };
}

/** Unset and blank (as `.env.example` leaves it) both mean not configured. */
const optionalSecret = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Config.map(Option.filter((secret) => Redacted.value(secret).trim() !== "")),
  );

/**
 * Optional: without `PRETIUM_API_KEY` the API still starts, and every
 * Pretium call fails as not configured.
 */
export const PretiumLive: Layer.Layer<Pretium, ConfigError.ConfigError> =
  Layer.effect(
    Pretium,
    Effect.gen(function* () {
      const apiKey = yield* optionalSecret("PRETIUM_API_KEY");
      const baseUrl = yield* Config.withDefault(
        Config.string("PRETIUM_BASE_URL"),
        PRETIUM_DEFAULT_BASE_URL,
      );
      const signingKey = yield* optionalSecret("PRETIUM_WEBHOOK_SIGNING_KEY");
      const callbackUrl = yield* Config.option(
        Config.string("PRETIUM_CALLBACK_URL"),
      ).pipe(Config.map(Option.filter((url) => url.trim() !== "")));
      return makePretium({
        apiKey: Option.getOrNull(apiKey),
        baseUrl,
        signingKey: Option.getOrNull(signingKey),
        callbackUrl: Option.getOrNull(callbackUrl),
      });
    }),
  );
