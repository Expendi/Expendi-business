/**
 * Proves a Base hop against the real chain, Privy and NEAR Intents for one
 * existing company: a 1Click quote that delivers exactly --usdc to the
 * company's own Base transit wallet, driven by the same advanceCompanyQuote
 * the payout jobs use (deposit-address registration, the relayer's fee cover,
 * the company wallet's gasless deposit, 1Click settlement). Then the deposit
 * watcher runs, to show the quote's buffer refund is not credited.
 *
 * Moves real USDC on mainnet. The quote is keyed by --run, so running it
 * again with the same --run resumes that quote rather than opening another.
 *
 * Run: pnpm --filter @expendi-business/api exec tsx scripts/near-mainnet-hop.ts \
 *        --organization-id <id> --run 1 [--usdc 0.1]
 */
import "../src/secrets/bootstrap.js";

import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { wallets } from "../src/db/schema/index.js";
import { query, withScope } from "../src/db/scope.js";
import { makeRuntime } from "../src/runtime.js";
import { baseUsdcBalance } from "../src/services/chain/base-rpc.js";
import { NearRpc } from "../src/services/chain/near-rpc.js";
import {
  advanceCompanyQuote,
  openCompanyQuote,
} from "../src/services/intents/quote-deposit.js";
import { watchNearDeposits } from "../src/services/wallet/near-deposits.js";

const SETTLED = new Set(["succeeded", "refunded", "failed", "expired"]);
const POLL_MS = 5_000;
const MAX_POLLS = 120;

const { values } = parseArgs({
  options: {
    "organization-id": { type: "string" },
    run: { type: "string" },
    usdc: { type: "string", default: "0.1" },
  },
});

const organizationId = values["organization-id"];
const run = values.run;
if (!organizationId || !run || !/^[a-z0-9-]+$/.test(run)) {
  throw new Error("Pass --organization-id <id> and --run <label>");
}

const toBaseUnits = (usdc: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) {
    throw new Error(`Not a USDC amount: ${usdc}`);
  }
  const [whole = "0", fraction = ""] = usdc.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const toUsdc = (units: bigint): string =>
  `${(units / 1_000_000n).toString()}.${(units % 1_000_000n).toString().padStart(6, "0")}`;

const runtime = makeRuntime();
try {
  const wallet = await runtime.runPromise(
    withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId)),
      ),
    ).pipe(Effect.map(([row]) => row)),
  );
  if (!wallet?.address || !wallet.transitAddress || wallet.chain !== "near") {
    throw new Error("The company has no active NEAR company wallet");
  }
  const companyAccount = wallet.address;
  const transitAddress = wallet.transitAddress;

  const balances = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const rpc = yield* NearRpc;
        return {
          companyNearUsdc: toUsdc(yield* rpc.usdcBalance(companyAccount)),
          transitBaseUsdc: toUsdc(yield* baseUsdcBalance(transitAddress)),
        };
      }),
    );
  console.log("Before", await balances());

  let quote = await runtime.runPromise(
    openCompanyQuote({
      organizationId,
      quoteKey: `near-mainnet-hop-${run}`,
      purpose: "base_hop",
      destinationChain: "base",
      recipient: transitAddress,
      amountOut: toBaseUnits(values.usdc),
      link: () => Effect.void,
    }),
  );
  console.log("Quote", {
    amountIn: toUsdc(quote.amountIn),
    amountOut: toUsdc(quote.amountOut),
    depositAddress: quote.depositAddress,
    deadline: quote.deadline.toISOString(),
  });

  const started = Date.now();
  let lastStatus = "";
  for (let poll = 0; poll < MAX_POLLS && !SETTLED.has(quote.status); poll++) {
    quote = await runtime.runPromise(
      advanceCompanyQuote({
        quote,
        beforeDeposit: () => Effect.succeed({ kind: "go" } as const),
      }),
    );
    const status = `${quote.status} / 1Click ${quote.oneClickStatus ?? "-"}`;
    if (status !== lastStatus) {
      console.log(
        `${String(Math.round((Date.now() - started) / 1000))}s  ${status}`,
      );
      lastStatus = status;
    }
    if (!SETTLED.has(quote.status)) await sleep(POLL_MS);
  }

  console.log("Settled", {
    status: quote.status,
    failure: quote.failure,
    registration: quote.depositRegistrationTxHash,
    feeCover: quote.feeCoverUsdc === null ? null : toUsdc(quote.feeCoverUsdc),
    feeCoverTx: quote.feeCoverTxHash,
    depositTx: quote.depositTxHash,
    baseDelivery: quote.destinationChainTxHashes,
    refunded:
      quote.refundedAmount === null ? null : toUsdc(quote.refundedAmount),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  await sleep(20_000);
  const watched = await runtime.runPromise(watchNearDeposits());
  console.log("Deposit watcher after the hop", watched);
  console.log("After", await balances());
} finally {
  await runtime.dispose();
}
