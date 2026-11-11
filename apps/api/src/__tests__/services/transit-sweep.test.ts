import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  advanceSweep,
  SWEEP_DUST_USDC,
  sweepTransitWallet,
} from "../../services/intents/sweep.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  readQuotes,
  updateQuote,
} from "../helpers/near-payouts.js";
import {
  claimRequest,
  ledgerBalance,
  payClaims,
  USDC,
} from "../helpers/payouts.js";

const world = makeNearPayoutWorld();
const { runtime, privy, oneClick } = world;
let db: Database;
let paying: NearPayingCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearPayingCompany(world, db);
});

const sweep = () =>
  runtime.runPromise(
    sweepTransitWallet({ organizationId: paying.company.organizationId }),
  );

const advance = (quote: IntentQuote) => runtime.runPromise(advanceSweep(quote));

const sweeps = async () =>
  (await readQuotes(db, paying.company)).filter(
    (quote) => quote.purpose === "sweep",
  );

const transitSends = () =>
  privy.state.sends.filter(
    (send) => send.privyWalletId === paying.transitPrivyWalletId,
  );

function delivered(quote: IntentQuote): void {
  oneClick.state.setStatus(quote.depositAddress, {
    status: "SUCCESS",
    depositedAmount: quote.amountIn,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    nearTxHashes: [randomTxHash()],
  });
}

describe("sweeping a transit wallet", () => {
  it("returns what sits there to the company wallet when nothing is in flight", async () => {
    // #given 5 USDC left in the transit wallet and nothing in flight
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);

    // #when the sweep runs
    const started = await sweep();

    // #then a Base to NEAR quote for exactly that balance is saved and paid
    // once from the transit wallet, and the ledger doesn't move
    expect({
      purpose: started?.purpose,
      swapType: started?.swapType,
      status: started?.status,
      amountIn: started?.amountIn,
      recipient: started?.recipient,
      refundTo: started?.refundTo,
      startedBeforeSend: started?.depositStartedAt !== null,
      sends: transitSends().map((send) => ({
        to: send.to,
        amount: send.amount,
        key: send.idempotencyKey,
      })),
      told: oneClick.state.submitted.some(
        (deposit) => deposit.depositAddress === started?.depositAddress,
      ),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      purpose: "sweep",
      swapType: "EXACT_INPUT",
      status: "depositing",
      amountIn: 5n * USDC,
      recipient: paying.accountId,
      refundTo: paying.transitAddress,
      startedBeforeSend: true,
      sends: [
        {
          to: started?.depositAddress,
          amount: 5n * USDC,
          key: `sweep-${started?.id ?? ""}`,
        },
      ],
      told: true,
      ledger: 100n * USDC,
    });
  });

  it("never sweeps the same balance twice", async () => {
    // #given a sweep under way, while Base still shows the old balance
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const started = await sweep();
    if (!started) throw new Error("no sweep");

    // #when the sweep job runs again, and the sweep itself is resumed
    const second = await sweep();
    await advance(started);

    // #then there is still one quote and one transfer
    expect({
      second,
      sweeps: (await sweeps()).length,
      sends: transitSends().length,
    }).toEqual({ second: null, sweeps: 1, sends: 1 });
  });

  it("settles when 1Click delivers, and finds nothing more to sweep", async () => {
    // #given a sweep 1Click delivered
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const started = await sweep();
    if (!started) throw new Error("no sweep");
    delivered(started);
    world.setBaseUsdc(paying.transitAddress, 0n);

    // #when it is resumed and the sweep job runs again
    const settled = await advance(started);
    const next = await sweep();

    // #then it succeeded, with 1Click's transactions saved for the deposit
    // watcher, and no new sweep starts
    expect({
      status: settled.status,
      hashes: settled.nearTxHashes.length,
      next,
    }).toEqual({ status: "succeeded", hashes: 1, next: null });
  });

  it("leaves dust where it is", async () => {
    // #given a balance at the dust threshold
    world.setBaseUsdc(paying.transitAddress, SWEEP_DUST_USDC);

    // #when the sweep runs
    const started = await sweep();

    // #then nothing is quoted or sent
    expect({ started, sweeps: (await sweeps()).length }).toEqual({
      started: null,
      sweeps: 0,
    });
  });

  it("waits while a cash-out is between its hop and its funding", async () => {
    // #given a cash-out whose hop is under way, and USDC in the transit wallet
    await payClaims(runtime, db, paying, [claimRequest()]);
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);

    // #when the sweep runs
    const started = await sweep();

    // #then nothing is swept
    expect({ started, sends: transitSends().length }).toEqual({
      started: null,
      sends: 0,
    });
  });

  it("sweeps at most the transit wallet's per-transaction cap at a time", async () => {
    // #given a transit wallet holding more than its cap
    paying = await createNearPayingCompany(world, db, {
      perTransactionMaxUsdc: 30n * USDC,
    });
    world.setBaseUsdc(paying.transitAddress, 45n * USDC);

    // #when the sweep runs
    const started = await sweep();

    // #then one transfer of the cap goes out
    expect(transitSends().map((send) => send.amount)).toEqual([30n * USDC]);
    expect(started?.amountIn).toBe(30n * USDC);
  });

  it("fails with nothing moved when the transit wallet refuses, and sweeps again later", async () => {
    // #given a transit wallet whose policy refuses the transfer
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    privy.state.nextSends("policy_violation");

    // #when the sweep runs, and then runs again
    const refused = await sweep();
    const retried = await sweep();

    // #then the first failed with nothing sent, and a new quote swept it
    expect({
      refused: refused?.status,
      retried: retried?.status,
      differentQuotes: refused?.id !== retried?.id,
      sends: transitSends().length,
    }).toEqual({
      refused: "failed",
      retried: "depositing",
      differentQuotes: true,
      sends: 1,
    });
  });

  it("goes to a person, and is never re-sent, when the transfer's outcome is unknown", async () => {
    // #given a sweep whose transfer got no answer
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    privy.state.nextSends("unknown");
    const unknown = await sweep();
    if (!unknown) throw new Error("no sweep");

    // #when the sweep and the sweep job run again
    await advance(unknown);
    const again = await sweep();

    // #then it stays under review with one attempt, and blocks a new sweep
    const [only, ...others] = await sweeps();
    expect({
      status: only?.status,
      others: others.length,
      again,
      attempts: transitSends().length,
    }).toEqual({ status: "needs_review", others: 0, again: null, attempts: 1 });

    // #when 1Click later reports it delivered the deposit
    delivered(unknown);
    const settled = await advance(unknown);

    // #then that settles it
    expect(settled.status).toBe("succeeded");
  });

  it("goes to a person when a crash left the transfer started with no answer saved", async () => {
    // #given a sweep recorded as started, whose transfer was never saved
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const started = await sweep();
    if (!started) throw new Error("no sweep");
    await updateQuote(db, paying.company, started.id, {
      depositPrivyTransactionId: null,
      depositTxHash: null,
      depositSubmittedAt: null,
    });

    // #when it is resumed
    const resumed = await advance(started);

    // #then nothing is sent again
    expect({
      status: resumed.status,
      sends: transitSends().length,
    }).toEqual({ status: "needs_review", sends: 1 });
  });

  it("expires with nothing moved when the balance is gone before the transfer", async () => {
    // #given a saved sweep whose transfer hasn't started
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const started = await sweep();
    if (!started) throw new Error("no sweep");
    await updateQuote(db, paying.company, started.id, {
      status: "quoted",
      depositStartedAt: null,
      depositPrivyTransactionId: null,
      depositTxHash: null,
      depositSubmittedAt: null,
    });
    world.setBaseUsdc(paying.transitAddress, 0n);

    // #when it is resumed
    const resumed = await advance(started);

    // #then it expired without another transfer
    expect({
      status: resumed.status,
      sends: transitSends().length,
    }).toEqual({ status: "expired", sends: 1 });
  });
});
