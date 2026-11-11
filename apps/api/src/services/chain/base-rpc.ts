import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";

import type { ReceiptLog, TransactionReceipt, UsdcTransfer } from "./base.js";
import {
  ERC20_TRANSFER_TOPIC,
  USDC_BASE_ADDRESS,
  usdcTransfersIn,
} from "./base.js";

export class BaseRpcError extends Data.TaggedError("BaseRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BaseRpcShape {
  /** Null while the transaction isn't mined (or doesn't exist on Base). */
  readonly getTransactionReceipt: (
    txHash: string,
  ) => Effect.Effect<TransactionReceipt | null, BaseRpcError>;
  /** A read-only `eth_call` at the latest block: the raw return data. */
  readonly ethCall: (
    to: string,
    data: string,
  ) => Effect.Effect<string, BaseRpcError>;
  /** The latest block's number. */
  readonly blockNumber: () => Effect.Effect<bigint, BaseRpcError>;
  /**
   * Every USDC transfer from `from` to `to` mined since `fromBlock`
   * (`eth_getLogs`; only successful transactions leave logs).
   */
  readonly usdcTransfersBetween: (filter: {
    readonly from: string;
    readonly to: string;
    readonly fromBlock: bigint;
  }) => Effect.Effect<UsdcTransfer[], BaseRpcError>;
}

export class BaseRpc extends Context.Tag("BaseRpc")<BaseRpc, BaseRpcShape>() {}

/** `balanceOf(address)` */
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";
const UINT256_WORD = /^0x[0-9a-fA-F]{64}$/;
const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The USDC an address holds on Base right now, in base units: what a
 * transit wallet can actually pay out, whatever our records expect.
 */
export function baseUsdcBalance(
  address: string,
): Effect.Effect<bigint, BaseRpcError, BaseRpc> {
  return Effect.gen(function* () {
    if (!BASE_ADDRESS.test(address)) {
      return yield* Effect.fail(
        new BaseRpcError({ message: `Not a Base address: ${address}` }),
      );
    }
    const rpc = yield* BaseRpc;
    const word = yield* rpc.ethCall(
      USDC_BASE_ADDRESS,
      `${ERC20_BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`,
    );
    return UINT256_WORD.test(word)
      ? BigInt(word)
      : yield* Effect.fail(
          new BaseRpcError({
            message: "Base RPC returned no USDC balance",
          }),
        );
  });
}

const RPC_TIMEOUT_MS = 10_000;

interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

export function makeBaseRpc(
  rpcUrl: Redacted.Redacted,
  fetchImpl: typeof fetch = fetch,
): BaseRpcShape {
  const call = <T>(method: string, params: readonly unknown[]) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(Redacted.value(rpcUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as JsonRpcResponse<T>;
      },
      catch: (cause) =>
        new BaseRpcError({ message: `Base RPC ${method} failed`, cause }),
    }).pipe(
      Effect.flatMap((body) =>
        body.error
          ? Effect.fail(
              new BaseRpcError({
                message: `Base RPC ${method} error ${body.error.code}: ${body.error.message}`,
              }),
            )
          : Effect.succeed(body.result ?? null),
      ),
    );

  return {
    getTransactionReceipt: (txHash) =>
      call<TransactionReceipt>("eth_getTransactionReceipt", [txHash]),
    ethCall: (to, data) =>
      call<string>("eth_call", [{ to, data }, "latest"]).pipe(
        Effect.flatMap((result) =>
          result === null
            ? Effect.fail(
                new BaseRpcError({
                  message: "Base RPC eth_call returned nothing",
                }),
              )
            : Effect.succeed(result),
        ),
      ),
    blockNumber: () =>
      call<string>("eth_blockNumber", []).pipe(
        Effect.flatMap((result) =>
          result === null
            ? Effect.fail(
                new BaseRpcError({
                  message: "Base RPC eth_blockNumber returned nothing",
                }),
              )
            : Effect.succeed(BigInt(result)),
        ),
      ),
    usdcTransfersBetween: ({ from, to, fromBlock }) =>
      call<readonly LogEntry[]>("eth_getLogs", [
        {
          address: USDC_BASE_ADDRESS,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: "latest",
        },
      ]).pipe(
        Effect.flatMap((logs) =>
          logs === null
            ? Effect.fail(
                new BaseRpcError({
                  message: "Base RPC eth_getLogs returned nothing",
                }),
              )
            : Effect.succeed(
                logs
                  .flatMap((log) =>
                    usdcTransfersIn({
                      transactionHash: log.transactionHash,
                      status: "0x1",
                      blockNumber: log.blockNumber,
                      logs: [log],
                    }),
                  )
                  .filter(
                    (transfer) =>
                      transfer.from === from.toLowerCase() &&
                      transfer.to === to.toLowerCase(),
                  ),
              ),
        ),
      ),
  };
}

/** An `eth_getLogs` entry: a receipt log that also names its transaction. */
interface LogEntry extends ReceiptLog {
  readonly transactionHash: string;
  readonly blockNumber: string;
}

const addressTopic = (address: string): string =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** BASE_RPC_URL usually embeds a provider API key, so it is redacted. */
export const BaseRpcLive: Layer.Layer<BaseRpc, ConfigError.ConfigError> =
  Layer.effect(
    BaseRpc,
    Effect.map(Config.redacted("BASE_RPC_URL"), (url) => makeBaseRpc(url)),
  );
