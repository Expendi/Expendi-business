import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import type { ConfigError } from "effect";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

import type { FundInChain, PayeeChain } from "@expendi-business/shared";

import type {
  IntentQuoteSwapType,
  OneClickStatus,
} from "../../db/schema/intent-quotes.js";
import { ONE_CLICK_STATUSES } from "../../db/schema/intent-quotes.js";

/**
 * The NEAR Intents 1Click API (docs/decisions/near-main-chain.md): it quotes
 * a move of an asset from one chain to another, gives a deposit address for
 * it, and reports what became of a deposit. Nothing here moves money; the
 * caller pays the deposit address itself.
 */

/**
 * USDC on each payee chain, as 1Click names it. Constants rather than
 * config, so a misconfigured environment can never quote another token.
 */
export const ONE_CLICK_USDC_ASSET_IDS = {
  near: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  solana: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
} as const satisfies Readonly<Record<PayeeChain, string>>;

/**
 * USDC on each chain a company can fund in from, as 1Click names it; checked
 * against `GET /v0/tokens` on 2026-11-10.
 */
export const ONE_CLICK_FUND_IN_USDC_ASSET_IDS = {
  base: ONE_CLICK_USDC_ASSET_IDS.base,
  ethereum: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  arbitrum: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  solana: ONE_CLICK_USDC_ASSET_IDS.solana,
} as const satisfies Readonly<Record<FundInChain, string>>;

/** The key 1Click signs every quote with. */
export const ONE_CLICK_QUOTE_SIGNER_PUBLIC_KEY =
  "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

export const ONE_CLICK_DEFAULT_BASE_URL = "https://1click.chaindefuser.com";

/**
 * 1Click answered and said no (HTTP 4xx): the request was invalid, unknown
 * or rate-limited, and nothing came of it. Asking again unchanged gets the
 * same answer, except after a 429.
 */
export class OneClickRefused extends Data.TaggedError("OneClickRefused")<{
  readonly message: string;
  readonly httpStatus: number;
}> {}

/**
 * Whether 1Click acted on the request is unknown: it timed out, the network
 * failed, 1Click answered 5xx, or its answer couldn't be read.
 */
export class OneClickOutcomeUnknown extends Data.TaggedError(
  "OneClickOutcomeUnknown",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * 1Click answered with a quote that must not be used: its signature isn't
 * 1Click's, or it is a quote for something other than what was asked.
 * Nothing may be sent to its deposit address.
 */
export class OneClickQuoteUntrusted extends Data.TaggedError(
  "OneClickQuoteUntrusted",
)<{
  readonly reason: "bad_signature" | "request_mismatch";
  readonly message: string;
}> {}

export type OneClickError = OneClickRefused | OneClickOutcomeUnknown;

export interface OneClickQuoteRequest {
  /** A dry quote prices the move without creating a deposit address. */
  readonly dry: boolean;
  /** Whether `amount` is what goes in or what comes out. */
  readonly swapType: IntentQuoteSwapType;
  /** 1Click asset IDs. */
  readonly originAsset: string;
  readonly destinationAsset: string;
  /** In the smallest unit of the asset `swapType` makes exact. */
  readonly amount: bigint;
  /** Who receives the destination asset, on its own chain. */
  readonly recipient: string;
  /** Where the origin asset returns to, on its own chain. */
  readonly refundTo: string;
  /** After this, 1Click refunds a deposit instead of delivering it. */
  readonly deadline: Date;
  /** Basis points: 100 is 1%. */
  readonly slippageBps: number;
  /** How long 1Click may wait for a better quote; it doesn't wait by default. */
  readonly quoteWaitingTimeMs?: number;
}

interface OneClickQuoteAmounts {
  readonly swapType: IntentQuoteSwapType;
  /** What to send to the deposit address, in the origin asset. */
  readonly amountIn: bigint;
  /** `EXACT_OUTPUT`: the least that still delivers `amountOut`. */
  readonly minAmountIn: bigint | null;
  /** What the recipient receives, in the destination asset. */
  readonly amountOut: bigint;
  /** `EXACT_INPUT`: the least the recipient may receive. */
  readonly minAmountOut: bigint | null;
  /** 1Click's estimate of how long the move takes, in seconds. */
  readonly timeEstimateSeconds: number | null;
  /** 1Click's ID for the request, to quote when asking them about it. */
  readonly correlationId: string;
  /**
   * 1Click's whole response as received, signature included: what
   * `intent_quotes.quote_response` keeps.
   */
  readonly signedResponse: unknown;
}

export interface OneClickDryQuote extends OneClickQuoteAmounts {
  readonly dry: true;
}

export interface OneClickFirmQuote extends OneClickQuoteAmounts {
  readonly dry: false;
  /** Where to send `amountIn`, on the origin chain. */
  readonly depositAddress: string;
  /**
   * Set when the origin chain needs a memo with the deposit. A deposit
   * without it is lost to the quote, so a caller that can't send one must
   * not use the quote.
   */
  readonly depositMemo: string | null;
  /**
   * The deadline the swap honours: the one we asked for, or 1Click's own if
   * that is earlier. 1Click's `quote.deadline` can run days past the one we
   * asked for (it keeps the deposit address open for refunds), so it is
   * never the time to stop depositing or to call a quote late.
   */
  readonly deadline: Date;
  /** When the deposit address stops taking deposits. */
  readonly timeWhenInactive: Date | null;
}

export type OneClickQuote = OneClickDryQuote | OneClickFirmQuote;

export interface OneClickSwapStatus {
  readonly status: OneClickStatus;
  readonly updatedAt: Date | null;
  /** What reached the deposit address; null until 1Click has counted it. */
  readonly depositedAmount: bigint | null;
  /** What the swap took and delivered; null until it settles. */
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
  /** What went back to the refund address; null when nothing has. */
  readonly refundedAmount: bigint | null;
  readonly refundReason: string | null;
  /**
   * Every transaction 1Click made or saw for the quote, exactly as it
   * reports them. NEAR hashes are base58 and case-sensitive.
   */
  readonly nearTxHashes: readonly string[];
  readonly originChainTxHashes: readonly string[];
  readonly destinationChainTxHashes: readonly string[];
}

export interface OneClickShape {
  /**
   * A quote whose signature is 1Click's and which answers exactly this
   * request. Only then may anything be sent to its deposit address.
   */
  readonly quote: (
    request: OneClickQuoteRequest,
  ) => Effect.Effect<OneClickQuote, OneClickError | OneClickQuoteUntrusted>;
  /** What 1Click says became of the quote with this deposit address. */
  readonly status: (
    depositAddress: string,
  ) => Effect.Effect<OneClickSwapStatus, OneClickError>;
  /**
   * Tells 1Click which transaction paid a deposit address, so it doesn't
   * have to find it. Safe to repeat.
   */
  readonly submitDeposit: (
    depositAddress: string,
    txHash: string,
  ) => Effect.Effect<void, OneClickError>;
}

export class OneClick extends Context.Tag("OneClick")<
  OneClick,
  OneClickShape
>() {}

const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_MAX_LENGTH = 300;

const amount = z.string().regex(/^\d{1,39}$/);
const optionalAmount = amount.nullish();

const quoteResponseSchema = z.object({
  correlationId: z.string(),
  timestamp: z.string().min(1),
  signature: z.string().min(1),
  quoteRequest: z.object({
    dry: z.boolean(),
    swapType: z.string(),
    slippageTolerance: z.number(),
    originAsset: z.string(),
    depositType: z.string(),
    destinationAsset: z.string(),
    amount: z.string(),
    refundTo: z.string(),
    refundType: z.string(),
    recipient: z.string(),
    recipientType: z.string(),
    deadline: z.string(),
  }),
  quote: z.object({
    amountIn: amount,
    minAmountIn: optionalAmount,
    amountOut: amount,
    minAmountOut: optionalAmount,
    timeEstimate: z.number().nullish(),
    depositAddress: z.string().min(1).nullish(),
    depositMemo: z.string().min(1).nullish(),
    deadline: z.iso.datetime({ offset: true }).nullish(),
    timeWhenInactive: z.iso.datetime({ offset: true }).nullish(),
  }),
});

type ParsedQuoteResponse = z.infer<typeof quoteResponseSchema>;

/**
 * The same response as the SDK's signature check reads it: the whole body,
 * including the fields this file doesn't use.
 */
const signedQuoteResponseSchema = z.custom<OneClickQuoteResponse>(
  (value) => quoteResponseSchema.safeParse(value).success,
);

const transactionSchema = z.object({ hash: z.string().min(1) });

const statusResponseSchema = z.object({
  status: z.enum(ONE_CLICK_STATUSES),
  updatedAt: z.iso.datetime({ offset: true }).nullish(),
  quoteResponse: z
    .object({
      quote: z.object({ depositAddress: z.string().nullish() }).optional(),
    })
    .optional(),
  swapDetails: z.object({
    nearTxHashes: z.array(z.string().min(1)).nullish(),
    originChainTxHashes: z.array(transactionSchema).nullish(),
    destinationChainTxHashes: z.array(transactionSchema).nullish(),
    depositedAmount: optionalAmount,
    amountIn: optionalAmount,
    amountOut: optionalAmount,
    refundedAmount: optionalAmount,
    refundReason: z.string().nullish(),
  }),
});

const errorBodySchema = z.object({ message: z.string() });

const toBigInt = (value: string | null | undefined): bigint | null =>
  value === null || value === undefined ? null : BigInt(value);

const toDate = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

const DEPOSIT_TYPE = "ORIGIN_CHAIN";
const REFUND_TYPE = "ORIGIN_CHAIN";
const RECIPIENT_TYPE = "DESTINATION_CHAIN";

/**
 * The body of `POST /v0/quote`. Deposits, refunds and deliveries are always
 * on the assets' own chains: Expendi holds nothing inside NEAR Intents.
 */
export function oneClickQuoteBody(
  request: OneClickQuoteRequest,
): Readonly<Record<string, unknown>> {
  return {
    dry: request.dry,
    swapType: request.swapType,
    slippageTolerance: request.slippageBps,
    originAsset: request.originAsset,
    depositType: DEPOSIT_TYPE,
    destinationAsset: request.destinationAsset,
    amount: request.amount.toString(),
    refundTo: request.refundTo,
    refundType: REFUND_TYPE,
    recipient: request.recipient,
    recipientType: RECIPIENT_TYPE,
    deadline: request.deadline.toISOString(),
    ...(request.quoteWaitingTimeMs !== undefined && {
      quoteWaitingTimeMs: request.quoteWaitingTimeMs,
    }),
  };
}

/**
 * The first field in which the quote 1Click returned isn't for `request`, or
 * null when it is. The signature covers every field compared here, so a
 * signed quote that passes was made for exactly this request.
 */
function requestMismatch(
  request: OneClickQuoteRequest,
  response: ParsedQuoteResponse,
): string | null {
  const echoed = response.quoteRequest;
  const exact = request.amount.toString();
  const differing: readonly (readonly [string, boolean])[] = [
    ["dry", echoed.dry !== request.dry],
    ["swapType", echoed.swapType !== request.swapType],
    ["originAsset", echoed.originAsset !== request.originAsset],
    ["destinationAsset", echoed.destinationAsset !== request.destinationAsset],
    ["amount", echoed.amount !== exact],
    ["recipient", echoed.recipient !== request.recipient],
    ["refundTo", echoed.refundTo !== request.refundTo],
    ["depositType", echoed.depositType !== DEPOSIT_TYPE],
    ["refundType", echoed.refundType !== REFUND_TYPE],
    ["recipientType", echoed.recipientType !== RECIPIENT_TYPE],
    ["slippageTolerance", echoed.slippageTolerance !== request.slippageBps],
    // 1Click rewrites the timestamp's format, so compare the instants.
    ["deadline", Date.parse(echoed.deadline) !== request.deadline.getTime()],
    [
      "quote amount",
      (request.swapType === "EXACT_OUTPUT"
        ? response.quote.amountOut
        : response.quote.amountIn) !== exact,
    ],
  ];
  return differing.find(([, differs]) => differs)?.[0] ?? null;
}

/** Null when a firm quote came without its deposit address or deadline. */
function toQuote(
  swapType: IntentQuoteSwapType,
  response: ParsedQuoteResponse,
  signedResponse: unknown,
): OneClickQuote | null {
  const { quote } = response;
  const amounts: OneClickQuoteAmounts = {
    swapType,
    amountIn: BigInt(quote.amountIn),
    minAmountIn: toBigInt(quote.minAmountIn),
    amountOut: BigInt(quote.amountOut),
    minAmountOut: toBigInt(quote.minAmountOut),
    timeEstimateSeconds: quote.timeEstimate ?? null,
    correlationId: response.correlationId,
    signedResponse,
  };
  if (response.quoteRequest.dry) return { ...amounts, dry: true };
  const depositAddress = quote.depositAddress ?? null;
  const quotedDeadline = toDate(quote.deadline);
  if (depositAddress === null || quotedDeadline === null) return null;
  const requestedDeadline = Date.parse(response.quoteRequest.deadline);
  const deadline = new Date(
    Math.min(quotedDeadline.getTime(), requestedDeadline),
  );
  return {
    ...amounts,
    dry: false,
    depositAddress,
    depositMemo: quote.depositMemo ?? null,
    deadline,
    timeWhenInactive: toDate(quote.timeWhenInactive),
  };
}

export interface OneClickSettings {
  readonly baseUrl: string;
  /** Sent as a bearer token; 1Click also answers without one. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /** Whose signature a quote must carry; only tests pass another key. */
  readonly quoteSignerPublicKey?: string;
}

export function makeOneClick(
  settings: OneClickSettings,
  fetchImpl: typeof fetch = fetch,
): OneClickShape {
  const signerPublicKey =
    settings.quoteSignerPublicKey ?? ONE_CLICK_QUOTE_SIGNER_PUBLIC_KEY;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...Option.match(settings.apiKey, {
      onNone: () => ({}),
      onSome: (apiKey) => ({
        authorization: `Bearer ${Redacted.value(apiKey)}`,
      }),
    }),
  });

  /** The JSON 1Click answered a 2xx with, before anything is read from it. */
  const request = (
    what: string,
    path: string,
    init: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly timeoutMs?: number;
    },
  ): Effect.Effect<unknown, OneClickError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(new URL(path, settings.baseUrl), {
          method: init.method,
          headers: headers(),
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        return { httpStatus: response.status, ok: response.ok, text };
      },
      catch: (cause) =>
        new OneClickOutcomeUnknown({
          message: `1Click ${what} didn't answer`,
          cause,
        }),
    }).pipe(
      Effect.flatMap(
        ({ httpStatus, ok, text }): Effect.Effect<unknown, OneClickError> => {
          if (httpStatus >= 400 && httpStatus < 500) {
            return Effect.fail(
              new OneClickRefused({
                message: `1Click refused ${what}: ${refusalReason(text)}`,
                httpStatus,
              }),
            );
          }
          if (!ok) {
            return Effect.fail(
              new OneClickOutcomeUnknown({
                message: `1Click ${what} failed with HTTP ${httpStatus}`,
              }),
            );
          }
          return Effect.try({
            try: (): unknown => JSON.parse(text),
            catch: (cause) =>
              new OneClickOutcomeUnknown({
                message: `1Click ${what} didn't answer with JSON`,
                cause,
              }),
          });
        },
      ),
    );

  const parsed = <T>(
    what: string,
    schema: z.ZodType<T>,
    body: unknown,
  ): Effect.Effect<T, OneClickOutcomeUnknown> => {
    const result = schema.safeParse(body);
    return result.success
      ? Effect.succeed(result.data)
      : Effect.fail(
          new OneClickOutcomeUnknown({
            message: `1Click ${what} returned an unexpected shape`,
            cause: result.error,
          }),
        );
  };

  return {
    quote: (quoteRequest) =>
      Effect.gen(function* () {
        const body = yield* request("quote", "/v0/quote", {
          method: "POST",
          body: oneClickQuoteBody(quoteRequest),
          timeoutMs:
            REQUEST_TIMEOUT_MS + (quoteRequest.quoteWaitingTimeMs ?? 0),
        });
        const response = yield* parsed("quote", quoteResponseSchema, body);
        // The signature is checked over the body exactly as it arrived, not
        // over the fields picked out above.
        const signed = yield* parsed("quote", signedQuoteResponseSchema, body);
        if (!verifyQuoteSignature(signed, signerPublicKey)) {
          return yield* Effect.fail(
            new OneClickQuoteUntrusted({
              reason: "bad_signature",
              message: "The quote isn't signed by 1Click",
            }),
          );
        }
        const mismatch = requestMismatch(quoteRequest, response);
        if (mismatch !== null) {
          return yield* Effect.fail(
            new OneClickQuoteUntrusted({
              reason: "request_mismatch",
              message: `1Click quoted something other than what was asked: ${mismatch} differs`,
            }),
          );
        }
        const quote = toQuote(quoteRequest.swapType, response, body);
        if (quote === null) {
          return yield* Effect.fail(
            new OneClickOutcomeUnknown({
              message: "1Click quote came without a deposit address",
            }),
          );
        }
        return quote;
      }),

    status: (depositAddress) =>
      Effect.gen(function* () {
        const body = yield* request(
          "status",
          `/v0/status?${new URLSearchParams({ depositAddress }).toString()}`,
          { method: "GET" },
        );
        const response = yield* parsed("status", statusResponseSchema, body);
        const reportedFor = response.quoteResponse?.quote?.depositAddress;
        if (typeof reportedFor === "string" && reportedFor !== depositAddress) {
          return yield* Effect.fail(
            new OneClickOutcomeUnknown({
              message: "1Click status answered for another deposit address",
            }),
          );
        }
        const details = response.swapDetails;
        return {
          status: response.status,
          updatedAt: toDate(response.updatedAt),
          depositedAmount: toBigInt(details.depositedAmount),
          amountIn: toBigInt(details.amountIn),
          amountOut: toBigInt(details.amountOut),
          refundedAmount: toBigInt(details.refundedAmount),
          refundReason: details.refundReason ?? null,
          nearTxHashes: details.nearTxHashes ?? [],
          originChainTxHashes: (details.originChainTxHashes ?? []).map(
            (transaction) => transaction.hash,
          ),
          destinationChainTxHashes: (
            details.destinationChainTxHashes ?? []
          ).map((transaction) => transaction.hash),
        };
      }),

    submitDeposit: (depositAddress, txHash) =>
      request("deposit submit", "/v0/deposit/submit", {
        method: "POST",
        body: { txHash, depositAddress },
      }).pipe(Effect.asVoid),
  };
}

/** What 1Click said was wrong, kept short: it goes into logs and errors. */
function refusalReason(text: string): string {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return text.slice(0, ERROR_BODY_MAX_LENGTH);
  }
  const error = errorBodySchema.safeParse(body);
  return (error.success ? error.data.message : text).slice(
    0,
    ERROR_BODY_MAX_LENGTH,
  );
}

/** ONECLICK_API_KEY is optional: 1Click also answers unauthenticated requests. */
export const OneClickLive: Layer.Layer<OneClick, ConfigError.ConfigError> =
  Layer.effect(
    OneClick,
    Effect.gen(function* () {
      const baseUrl = yield* Config.withDefault(
        Config.string("ONECLICK_BASE_URL"),
        ONE_CLICK_DEFAULT_BASE_URL,
      );
      const apiKey = yield* Config.option(Config.redacted("ONECLICK_API_KEY"));
      return makeOneClick({ baseUrl, apiKey });
    }),
  );
