import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { z } from "zod";

import type { NearTransactionOutcome } from "./near.js";
import { NearChain } from "./near.js";

export class NearRpcError extends Data.TaggedError("NearRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NearBlock {
  readonly height: bigint;
  /** Base58. */
  readonly hash: string;
}

export interface NearRpcShape {
  /**
   * Null until the transaction and every receipt it caused are final, and
   * while the chain doesn't know the hash at all. NEAR looks a transaction
   * up by its hash and the account that signed it.
   */
  readonly transactionOutcome: (
    txHash: string,
    signerAccountId: string,
  ) => Effect.Effect<NearTransactionOutcome | null, NearRpcError>;
  readonly accountExists: (
    accountId: string,
  ) => Effect.Effect<boolean, NearRpcError>;
  /** Whether the USDC contract will hold a balance for the account. */
  readonly usdcStorageRegistered: (
    accountId: string,
  ) => Effect.Effect<boolean, NearRpcError>;
  /** USDC base units; zero for an account that isn't registered. */
  readonly usdcBalance: (
    accountId: string,
  ) => Effect.Effect<bigint, NearRpcError>;
  /**
   * What the account holds inside the NEAR Intents contract, per token ID,
   * in base units and in the order of `tokenIds`. Zero for a token it holds
   * none of.
   */
  readonly intentsBalances: (
    accountId: string,
    tokenIds: readonly string[],
  ) => Effect.Effect<readonly bigint[], NearRpcError>;
  /**
   * The NEAR Intents contract's `current_salt`, the four bytes a versioned
   * nonce must carry for the contract to accept it.
   */
  readonly intentsSalt: () => Effect.Effect<Uint8Array, NearRpcError>;
  /** The latest block that can no longer be reverted. */
  readonly finalBlock: () => Effect.Effect<NearBlock, NearRpcError>;
  /**
   * The nonce of one of an account's access keys, or null if the account or
   * the key doesn't exist. With `atBlockHeight` the answer is for exactly
   * that block, and a node that hasn't reached it fails instead of answering
   * from an older one.
   */
  readonly accessKeyNonce: (input: {
    readonly accountId: string;
    readonly publicKey: string;
    readonly atBlockHeight?: bigint;
  }) => Effect.Effect<bigint | null, NearRpcError>;
  /**
   * Hands a signed transaction to the network without waiting for it. A
   * failure here doesn't mean it wasn't accepted: ask for its outcome.
   */
  readonly broadcast: (
    signedTransaction: Uint8Array,
  ) => Effect.Effect<void, NearRpcError>;
}

export class NearRpc extends Context.Tag("NearRpc")<NearRpc, NearRpcShape>() {}

const RPC_TIMEOUT_MS = 10_000;

/** The node answered, but not with a success status. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * What went wrong with a request, for the error message. Only the status or
 * a fixed phrase: the cause of a failed fetch can name the URL, which usually
 * carries a provider API key.
 */
function transportFailure(cause: unknown): string {
  if (cause instanceof HttpStatusError) return `HTTP ${cause.status}`;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "timed out";
  }
  if (cause instanceof SyntaxError || cause instanceof z.ZodError) {
    return "unreadable response";
  }
  return "network error";
}

const rpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string().optional(),
      cause: z.object({ name: z.string().optional() }).optional(),
    })
    .optional(),
});

/** A JSON number the chain uses for a count: a block height or a nonce. */
const chainCount = z.number().int().nonnegative().safe();

const blockSchema = z.object({
  header: z.object({ height: chainCount, hash: z.string().min(1) }),
});

const accessKeySchema = z.object({ nonce: chainCount });

const viewCallSchema = z.object({ result: z.array(z.number().int()) });

const executionStatusSchema = z.union([
  z.object({ SuccessValue: z.string() }),
  z.object({ SuccessReceiptId: z.string() }),
  z.object({ Failure: z.unknown() }),
]);

const transactionProgressSchema = z.object({
  final_execution_status: z.string(),
});

const finalTransactionSchema = z.object({
  status: z.union([
    z.object({ SuccessValue: z.string() }),
    z.object({ Failure: z.unknown() }),
  ]),
  transaction: z.object({
    hash: z.string().min(1),
    signer_id: z.string(),
    receiver_id: z.string(),
  }),
  transaction_outcome: z.object({
    block_hash: z.string().min(1),
    outcome: z.object({ receipt_ids: z.tuple([z.string().min(1)]) }),
  }),
  receipts_outcome: z.array(
    z.object({
      id: z.string(),
      outcome: z.object({
        executor_id: z.string(),
        logs: z.array(z.string()),
        status: executionStatusSchema,
      }),
    }),
  ),
});

type RpcReply =
  | { readonly kind: "result"; readonly result: unknown }
  | {
      readonly kind: "error";
      readonly cause: string;
      readonly message: string;
    };

export function makeNearRpc(
  rpcUrl: Redacted.Redacted,
  usdcContractId: string,
  intentsContractId: string,
  fetchImpl: typeof fetch = fetch,
): NearRpcShape {
  const request = (
    method: string,
    params: unknown,
  ): Effect.Effect<RpcReply, NearRpcError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(Redacted.value(rpcUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new HttpStatusError(response.status);
        }
        return rpcResponseSchema.parse(await response.json());
      },
      catch: (cause) =>
        new NearRpcError({
          message: `NEAR RPC ${method} failed: ${transportFailure(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.map((body): RpcReply =>
        body.error
          ? {
              kind: "error",
              cause: body.error.cause?.name ?? body.error.name ?? "UNKNOWN",
              message: body.error.message ?? "no message",
            }
          : { kind: "result", result: body.result },
      ),
    );

  const malformed = (method: string, cause: unknown) =>
    new NearRpcError({
      message: `NEAR RPC ${method} returned an unexpected shape`,
      cause,
    });

  /**
   * The parsed result, or null when the node answers with one of the
   * `absent` error causes: NEAR reports "no such account" and the like as
   * errors, and they are answers here.
   */
  const call = <T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    absent: readonly string[] = [],
  ): Effect.Effect<T | null, NearRpcError> =>
    request(method, params).pipe(
      Effect.flatMap((reply) => {
        if (reply.kind === "error") {
          return absent.includes(reply.cause)
            ? Effect.succeed(null)
            : Effect.fail(
                new NearRpcError({
                  message: `NEAR RPC ${method} error ${reply.cause}: ${reply.message}`,
                }),
              );
        }
        const parsed = schema.safeParse(reply.result);
        return parsed.success
          ? Effect.succeed(parsed.data)
          : Effect.fail(malformed(method, parsed.error));
      }),
    );

  const required = <T>(
    method: string,
    value: T | null,
  ): Effect.Effect<T, NearRpcError> =>
    value === null
      ? Effect.fail(
          new NearRpcError({ message: `NEAR RPC ${method} returned nothing` }),
        )
      : Effect.succeed(value);

  const block = (params: unknown): Effect.Effect<NearBlock, NearRpcError> =>
    call("block", params, blockSchema).pipe(
      Effect.flatMap((result) => required("block", result)),
      Effect.map(({ header }) => ({
        height: BigInt(header.height),
        hash: header.hash,
      })),
    );

  /** A read-only call to a contract at the final block: its JSON result. */
  const viewContract = (
    contractId: string,
    methodName: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, NearRpcError> =>
    call(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
      viewCallSchema,
    ).pipe(
      Effect.flatMap((result) => required(`query ${methodName}`, result)),
      Effect.flatMap(({ result }) =>
        Effect.try({
          try: (): unknown => JSON.parse(Buffer.from(result).toString("utf8")),
          catch: (cause) => malformed(`query ${methodName}`, cause),
        }),
      ),
    );

  const viewUsdc = (
    methodName: string,
    args: Readonly<Record<string, string>>,
  ): Effect.Effect<unknown, NearRpcError> =>
    viewContract(usdcContractId, methodName, args);

  return {
    transactionOutcome: (txHash, signerAccountId) =>
      Effect.gen(function* () {
        const raw = yield* call(
          "tx",
          {
            tx_hash: txHash,
            sender_account_id: signerAccountId,
            wait_until: "NONE",
          },
          z.unknown(),
          ["UNKNOWN_TRANSACTION"],
        );
        if (raw === null || raw === undefined) return null;
        const progress = transactionProgressSchema.safeParse(raw);
        if (!progress.success) {
          return yield* Effect.fail(malformed("tx", progress.error));
        }
        if (progress.data.final_execution_status !== "FINAL") return null;
        const parsed = finalTransactionSchema.safeParse(raw);
        if (!parsed.success) {
          return yield* Effect.fail(malformed("tx", parsed.error));
        }
        const final = parsed.data;
        const included = yield* block({
          block_id: final.transaction_outcome.block_hash,
        });
        return {
          txHash: final.transaction.hash,
          signerId: final.transaction.signer_id,
          receiverId: final.transaction.receiver_id,
          blockHeight: included.height,
          succeeded: "SuccessValue" in final.status,
          successValue:
            "SuccessValue" in final.status ? final.status.SuccessValue : null,
          ownReceiptId: final.transaction_outcome.outcome.receipt_ids[0],
          receipts: final.receipts_outcome.map((receipt) => ({
            receiptId: receipt.id,
            executorId: receipt.outcome.executor_id,
            logs: receipt.outcome.logs,
            succeeded: !("Failure" in receipt.outcome.status),
          })),
        };
      }),

    accountExists: (accountId) =>
      call(
        "query",
        {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
        z.object({}),
        ["UNKNOWN_ACCOUNT"],
      ).pipe(Effect.map((account) => account !== null)),

    usdcStorageRegistered: (accountId) =>
      viewUsdc("storage_balance_of", { account_id: accountId }).pipe(
        Effect.map((balance) => balance !== null),
      ),

    usdcBalance: (accountId) =>
      viewUsdc("ft_balance_of", { account_id: accountId }).pipe(
        Effect.flatMap((balance) => {
          const parsed = z.string().regex(/^\d+$/).safeParse(balance);
          return parsed.success
            ? Effect.succeed(BigInt(parsed.data))
            : Effect.fail(malformed("query ft_balance_of", parsed.error));
        }),
      ),

    intentsBalances: (accountId, tokenIds) =>
      tokenIds.length === 0
        ? Effect.succeed([])
        : viewContract(intentsContractId, "mt_batch_balance_of", {
            account_id: accountId,
            token_ids: tokenIds,
          }).pipe(
            Effect.flatMap((balances) => {
              const parsed = z
                .array(z.string().regex(/^\d{1,39}$/))
                .length(tokenIds.length)
                .safeParse(balances);
              return parsed.success
                ? Effect.succeed(parsed.data.map((amount) => BigInt(amount)))
                : Effect.fail(
                    malformed("query mt_batch_balance_of", parsed.error),
                  );
            }),
          ),

    intentsSalt: () =>
      viewContract(intentsContractId, "current_salt", {}).pipe(
        Effect.flatMap((salt) => {
          const parsed = z
            .string()
            .regex(/^[0-9a-f]{8}$/)
            .safeParse(salt);
          return parsed.success
            ? Effect.succeed(Uint8Array.from(Buffer.from(parsed.data, "hex")))
            : Effect.fail(malformed("query current_salt", parsed.error));
        }),
      ),

    finalBlock: () => block({ finality: "final" }),

    accessKeyNonce: ({ accountId, publicKey, atBlockHeight }) =>
      call(
        "query",
        {
          request_type: "view_access_key",
          account_id: accountId,
          public_key: publicKey,
          ...(atBlockHeight === undefined
            ? { finality: "final" }
            : { block_id: Number(atBlockHeight) }),
        },
        accessKeySchema,
        ["UNKNOWN_ACCOUNT", "UNKNOWN_ACCESS_KEY"],
      ).pipe(Effect.map((key) => (key === null ? null : BigInt(key.nonce)))),

    broadcast: (signedTransaction) =>
      call(
        "broadcast_tx_async",
        [Buffer.from(signedTransaction).toString("base64")],
        z.string(),
      ).pipe(Effect.asVoid),
  };
}

/** NEAR_RPC_URL usually embeds a provider API key, so it is redacted. */
export const NearRpcLive: Layer.Layer<
  NearRpc,
  ConfigError.ConfigError,
  NearChain
> = Layer.effect(
  NearRpc,
  Effect.gen(function* () {
    const chain = yield* NearChain;
    const url = yield* Config.redacted("NEAR_RPC_URL");
    return makeNearRpc(url, chain.usdcContractId, chain.intentsContractId);
  }),
);
