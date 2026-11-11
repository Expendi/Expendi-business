import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { z } from "zod";

import { NearChain } from "./near.js";

/**
 * The FastNEAR Transfers API: an indexer that lists the token transfers an
 * account received. It only says where to look. Nothing it reports is
 * credited until the RPC confirms it (docs/decisions/near-main-chain.md,
 * "Telling internal transfers from deposits").
 */

export class FastNearError extends Data.TaggedError("FastNearError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** One USDC transfer the indexer says an account received. */
export interface FastNearTransfer {
  readonly blockHeight: bigint;
  /** Base58 and case-sensitive: never lowercase it. */
  readonly transactionId: string;
  readonly receiptId: string;
  readonly logIndex: number | null;
  /** Who signed the transaction: what the RPC needs to look it up. */
  readonly signerId: string;
  /** The sender, as the indexer read it. */
  readonly otherAccountId: string | null;
  /** USDC base units, as the indexer read them. */
  readonly amount: bigint;
}

export interface FastNearTransferPage {
  /** Oldest first. */
  readonly transfers: readonly FastNearTransfer[];
  /** Where the next page starts; null when the indexer gave none. */
  readonly resumeToken: string | null;
}

export const FAST_NEAR_MAX_PAGE_SIZE = 100;

export interface FastNearShape {
  /** USDC transfers `accountId` received, oldest first, after `resumeToken`. */
  readonly usdcTransfersTo: (input: {
    readonly accountId: string;
    /** 1 to 100. */
    readonly limit: number;
    readonly resumeToken: string | null;
  }) => Effect.Effect<FastNearTransferPage, FastNearError>;
}

export class FastNear extends Context.Tag("FastNear")<
  FastNear,
  FastNearShape
>() {}

export const FAST_NEAR_DEFAULT_TRANSFERS_URL =
  "https://transfers.main.fastnear.com/v0/transfers";

const REQUEST_TIMEOUT_MS = 10_000;

/** A count the indexer gives as a JSON number or as a decimal string. */
const count = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d{1,18}$/),
]);

const transferSchema = z.object({
  block_height: count,
  transaction_id: z.string().min(1),
  receipt_id: z.string().min(1),
  log_index: z.number().int().nonnegative().nullish(),
  signer_id: z.string().min(1),
  other_account_id: z.string().nullish(),
  amount: z.string().regex(/^\d{1,39}$/),
});

const pageSchema = z.object({
  transfers: z.array(transferSchema),
  resume_token: z.string().min(1).nullish(),
});

export interface FastNearSettings {
  readonly transfersUrl: string;
  /** Sent as a bearer token; the API also answers without one. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  readonly usdcContractId: string;
}

/** The body of one page request. No `desc`: the watcher reads oldest first. */
export function fastNearTransfersBody(input: {
  readonly accountId: string;
  readonly usdcContractId: string;
  readonly limit: number;
  readonly resumeToken: string | null;
}): Readonly<Record<string, unknown>> {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FAST_NEAR_MAX_PAGE_SIZE
  ) {
    throw new RangeError(`Page size out of range: ${input.limit}`);
  }
  return {
    account_id: input.accountId,
    direction: "receiver",
    asset_id: `nep141:${input.usdcContractId}`,
    limit: input.limit,
    ...(input.resumeToken !== null && { resume_token: input.resumeToken }),
  };
}

export function makeFastNear(
  settings: FastNearSettings,
  fetchImpl: typeof fetch = fetch,
): FastNearShape {
  return {
    usdcTransfersTo: ({ accountId, limit, resumeToken }) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(settings.transfersUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...Option.match(settings.apiKey, {
                onNone: () => ({}),
                onSome: (apiKey) => ({
                  authorization: `Bearer ${Redacted.value(apiKey)}`,
                }),
              }),
            },
            body: JSON.stringify(
              fastNearTransfersBody({
                accountId,
                usdcContractId: settings.usdcContractId,
                limit,
                resumeToken,
              }),
            ),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return pageSchema.parse(await response.json());
        },
        catch: (cause) =>
          new FastNearError({
            message: "FastNEAR transfers request failed",
            cause,
          }),
      }).pipe(
        Effect.map((page) => ({
          transfers: page.transfers.map((transfer) => ({
            blockHeight: BigInt(transfer.block_height),
            transactionId: transfer.transaction_id,
            receiptId: transfer.receipt_id,
            logIndex: transfer.log_index ?? null,
            signerId: transfer.signer_id,
            otherAccountId: transfer.other_account_id ?? null,
            amount: BigInt(transfer.amount),
          })),
          resumeToken: page.resume_token ?? null,
        })),
      ),
  };
}

/** FASTNEAR_API_KEY is optional: the API also answers unauthenticated requests. */
export const FastNearLive: Layer.Layer<
  FastNear,
  ConfigError.ConfigError,
  NearChain
> = Layer.effect(
  FastNear,
  Effect.gen(function* () {
    const chain = yield* NearChain;
    const transfersUrl = yield* Config.withDefault(
      Config.string("FASTNEAR_TRANSFERS_URL"),
      FAST_NEAR_DEFAULT_TRANSFERS_URL,
    );
    const apiKey = yield* Config.option(Config.redacted("FASTNEAR_API_KEY"));
    return makeFastNear({
      transfersUrl,
      apiKey,
      usdcContractId: chain.usdcContractId,
    });
  }),
);
