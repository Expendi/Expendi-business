/**
 * Proves the NEAR money path against the real chain, Privy and FastNEAR for
 * one existing company (scripts/create-test-company.ts makes one):
 *
 * 1. the gas relayer sends USDC to the company wallet;
 * 2. the deposit watcher reads it and treats it as internal, crediting nothing,
 *    because the relayer's own transfers are never deposits;
 * 3. the company wallet sends USDC back as a Privy-signed delegate action that
 *    the relayer pays the gas for.
 *
 * Moves real USDC on mainnet. Each step is keyed by --run, so running it again
 * with the same --run moves nothing twice.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/near-mainnet-smoke.ts \
 *        --organization-id <id> --run 1 [--usdc 0.5] [--back 0.2]
 */
import "../src/secrets/bootstrap.js";

import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { wallets, walletTransactions } from "../src/db/schema/index.js";
import { query, withScope } from "../src/db/scope.js";
import { makeRuntime } from "../src/runtime.js";
import { NearRelayer } from "../src/services/chain/near-relayer.js";
import { NearRpc } from "../src/services/chain/near-rpc.js";
import { sendUsdcFromCompanyWallet } from "../src/services/wallet/company-wallet-send.js";
import { watchNearDeposits } from "../src/services/wallet/near-deposits.js";

const { values } = parseArgs({
  options: {
    "organization-id": { type: "string" },
    run: { type: "string" },
    usdc: { type: "string", default: "0.5" },
    back: { type: "string", default: "0.2" },
  },
});

const organizationId = values["organization-id"];
const run = values.run;
if (!organizationId || !run || !/^[a-z0-9-]+$/.test(run)) {
  throw new Error("Pass --organization-id <id> and --run <label>");
}

const toBaseUnits = (usdc: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(usdc))
    throw new Error(`Not a USDC amount: ${usdc}`);
  const [whole = "0", fraction = ""] = usdc.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const toUsdc = (units: bigint): string =>
  `${(units / 1_000_000n).toString()}.${(units % 1_000_000n).toString().padStart(6, "0")}`;

const nearblocks = (txHash: string) => `https://nearblocks.io/txns/${txHash}`;

const program = Effect.gen(function* () {
  const relayer = yield* NearRelayer;
  const rpc = yield* NearRpc;
  const scope = { organizationId };

  const [wallet] = yield* withScope(scope, (tx) =>
    query(() =>
      tx
        .select()
        .from(wallets)
        .where(eq(wallets.organizationId, organizationId)),
    ),
  );
  if (
    !wallet?.address ||
    wallet.chain !== "near" ||
    wallet.status !== "active"
  ) {
    return yield* Effect.dieMessage(
      "The company has no active NEAR company wallet",
    );
  }
  const companyAccount = wallet.address;

  const before = {
    relayerUsdc: yield* rpc.usdcBalance(relayer.accountId),
    companyUsdc: yield* rpc.usdcBalance(companyAccount),
  };
  console.log("Before", {
    relayerUsdc: toUsdc(before.relayerUsdc),
    companyUsdc: toUsdc(before.companyUsdc),
  });

  const funded = yield* relayer.sendUsdc({
    to: companyAccount,
    amount: toBaseUnits(values.usdc),
    beforeBroadcast: (txHash) =>
      Effect.sync(() =>
        console.log(`1. Relayer → company wallet: ${nearblocks(txHash)}`),
      ),
  });
  yield* relayer.awaitOutcome(funded.txHash);

  const watched = yield* watchNearDeposits();
  const ledger = yield* withScope(scope, (tx) =>
    query(() =>
      tx
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(eq(walletTransactions.organizationId, organizationId)),
    ),
  );
  console.log("2. Deposit watcher", { ...watched, ledgerRows: ledger.length });

  const sent = yield* sendUsdcFromCompanyWallet({
    organizationId,
    sendKey: `near-mainnet-smoke-${run}`,
    to: relayer.accountId,
    amount: toBaseUnits(values.back),
  });
  console.log(
    `3. Company wallet → relayer, gas paid by the relayer: ${nearblocks(sent.txHash)}`,
  );

  const companyNear = yield* rpc.accountExists(companyAccount);
  const after = {
    relayerUsdc: yield* rpc.usdcBalance(relayer.accountId),
    companyUsdc: yield* rpc.usdcBalance(companyAccount),
  };
  console.log("After", {
    relayerUsdc: toUsdc(after.relayerUsdc),
    companyUsdc: toUsdc(after.companyUsdc),
    companyAccountExists: companyNear,
  });
});

const runtime = makeRuntime();
try {
  await runtime.runPromise(program);
} finally {
  await runtime.dispose();
}
