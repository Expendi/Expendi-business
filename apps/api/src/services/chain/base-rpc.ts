import type { ConfigError } from "effect";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";

import type { TransactionReceipt } from "./base.js";

export class BaseRpcError extends Data.TaggedError("BaseRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BaseRpcShape {
  /** Null while the transaction isn't mined (or doesn't exist on Base). */
  readonly getTransactionReceipt: (
    txHash: string,
  ) => Effect.Effect<TransactionReceipt | null, BaseRpcError>;
}

export class BaseRpc extends Context.Tag("BaseRpc")<BaseRpc, BaseRpcShape>() {}

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
  };
}

/** BASE_RPC_URL usually embeds a provider API key, so it is redacted. */
export const BaseRpcLive: Layer.Layer<BaseRpc, ConfigError.ConfigError> =
  Layer.effect(
    BaseRpc,
    Effect.map(Config.redacted("BASE_RPC_URL"), (url) => makeBaseRpc(url)),
  );
