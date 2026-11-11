/**
 * Shows whether the gas relayer (docs/decisions/near-main-chain.md) is ready:
 * that its account exists, is registered with the USDC contract, and what
 * USDC it holds to cover Base hop fees.
 *
 * With --register it also pays its own USDC registration (0.00125 NEAR),
 * which it needs before anyone can send it USDC. Safe to run again.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/near-relayer-status.ts [--register]
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { Effect, Layer } from "effect";

import {
  NearRelayer,
  NearRelayerLive,
} from "../src/services/chain/near-relayer.js";
import { NearRpc, NearRpcLive } from "../src/services/chain/near-rpc.js";
import { NearChainLive } from "../src/services/chain/near.js";
import { PrivyWalletsLive } from "../src/services/wallet/privy-wallets.js";

const { values } = parseArgs({ options: { register: { type: "boolean" } } });

const rpcLayer = NearRpcLive.pipe(Layer.provide(NearChainLive));
const layers = Layer.mergeAll(
  NearChainLive,
  rpcLayer,
  NearRelayerLive.pipe(
    Layer.provide(Layer.mergeAll(NearChainLive, rpcLayer, PrivyWalletsLive)),
  ),
);

const status = Effect.gen(function* () {
  const relayer = yield* NearRelayer;
  const rpc = yield* NearRpc;
  if (values.register === true) {
    yield* relayer.activateAccount(relayer.accountId);
  }
  const exists = yield* rpc.accountExists(relayer.accountId);
  const registered = exists
    ? yield* rpc.usdcStorageRegistered(relayer.accountId)
    : false;
  const usdc = registered ? yield* rpc.usdcBalance(relayer.accountId) : 0n;
  return {
    accountId: relayer.accountId,
    existsOnChain: exists,
    registeredForUsdc: registered,
    usdcBaseUnits: usdc.toString(),
  };
});

console.log(await Effect.runPromise(status.pipe(Effect.provide(layers))));
