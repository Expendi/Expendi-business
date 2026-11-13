import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { creditSettledQuote } from "../../services/intents/quote-credit.js";
import {
  advanceSweep,
  SWEEP_DUST_USDC,
  sweepTransitWallet,
} from "../../services/intents/sweep.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { randomTxHash } from "../helpers/chain.js";
import { saveQuote } from "../helpers/money-in.js";
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
  updatePayout,
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

  it.each<[Payout["status"], boolean]>([
    ["approved", false],
    ["funding", false],
    ["paying", true],
    ["paid", true],
  ])(
    "with a Pretium cash-out %s, sweeps only once its USDC has left (%s)",
    async (status, sweeps) => {
      // #given a Pretium cash-out with no hop in flight, and USDC in the
      // transit wallet
      const [prepared] = await runtime.runPromise(
        preparePayouts({
          organizationId: paying.company.organizationId,
          actor: { type: "user", id: paying.company.admin.id },
          requests: [claimRequest()],
        }),
      );
      if (!prepared) throw new Error("nothing prepared");
      await updatePayout(db, paying.company, prepared.id, {
        provider: "pretium",
        status,
        approvalId: randomUUID(),
        approvedBy: paying.company.admin.id,
        approvedAt: new Date(),
        ...(status !== "approved" && {
          fundingStartedAt: new Date(),
          amountToTransferUsdc: 11n * USDC,
          depositAddress: PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase(),
        }),
      });
      world.setBaseUsdc(paying.transitAddress, 5n * USDC);

      // #when the sweep runs
      const started = await sweep();

      // #then
      expect({
        started: started !== null,
        sends: transitSends().length,
      }).toEqual({ started: sweeps, sends: sweeps ? 1 : 0 });
    },
  );

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

describe("sweeping the transit wallet of a company whose USDC is in a confidential account", () => {
  const callsBefore = () => oneClick.state.calls.length;

  beforeEach(async () => {
    paying = await createNearPayingCompany(world, db, {
      balanceHome: "confidential_account",
    });
  });

  it("delivers into the account, with the company's session, and refunds to the transit wallet on Base", async () => {
    // #given 5 USDC in the transit wallet
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const before = callsBefore();

    // #when the sweep runs
    const started = await sweep();
    if (!started) throw new Error("no sweep");

    // #then 1Click was asked for a delivery into the confidential account,
    // refunding on Base, with a session, and the row says the same
    const request = oneClick.state.quotes.get(started.depositAddress)?.request;
    expect({
      request: {
        swapType: request?.swapType,
        amount: request?.amount,
        recipient: request?.recipient,
        recipientType: request?.recipientType,
        refundTo: request?.refundTo,
        refundType: request?.refundType,
        depositType: request?.depositType,
      },
      row: {
        recipientType: started.recipientType,
        recipient: started.recipient,
        refundTo: started.refundTo,
        depositType: started.depositType,
        refundType: started.refundType,
      },
      sessions: oneClick.state.calls
        .slice(before)
        .filter((entry) => entry.call === "quote")
        .map((entry) => entry.session !== undefined),
      sends: transitSends().length,
    }).toEqual({
      request: {
        swapType: "EXACT_INPUT",
        amount: 5n * USDC,
        recipient: paying.accountId,
        recipientType: "CONFIDENTIAL_INTENTS",
        refundTo: paying.transitAddress,
        refundType: undefined,
        depositType: undefined,
      },
      row: {
        recipientType: "CONFIDENTIAL_INTENTS",
        recipient: paying.accountId,
        refundTo: paying.transitAddress,
        depositType: "ORIGIN_CHAIN",
        refundType: "ORIGIN_CHAIN",
      },
      sessions: [true],
      sends: 1,
    });
  });

  it("asks 1Click about the sweep with the session, and is never a ledger entry", async () => {
    // #given a sweep 1Click delivered into the account
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const started = await sweep();
    if (!started) throw new Error("no sweep");
    delivered(started);
    world.setBaseUsdc(paying.transitAddress, 0n);

    // #when it is resumed, and the credit job considers it
    const settled = await advance(started);
    const credit = await runtime.runPromise(
      creditSettledQuote({
        quoteId: started.id,
        organizationId: paying.company.organizationId,
      }),
    );

    // #then it succeeded, the status and the deposit notice carried the
    // session, and the ledger holds only the opening deposit
    const sessionless = oneClick.state.calls.filter(
      (entry) =>
        entry.depositAddress === started.depositAddress &&
        entry.session === undefined,
    );
    expect({
      status: settled.status,
      credit,
      ledger: await ledgerBalance(db, paying.company),
      sessionless: sessionless.length,
    }).toEqual({
      status: "succeeded",
      credit: "not_creditable",
      ledger: 100n * USDC,
      sessionless: 0,
    });
  });

  it("leaves dust in the transit wallet: nothing is quoted at the threshold", async () => {
    // #given a balance at the dust threshold
    world.setBaseUsdc(paying.transitAddress, SWEEP_DUST_USDC);
    const before = callsBefore();

    // #when the sweep runs
    const started = await sweep();

    // #then nothing is quoted or sent
    expect({
      started,
      quotes: oneClick.state.calls
        .slice(before)
        .filter((entry) => entry.call === "quote").length,
      sends: transitSends().length,
    }).toEqual({ started: null, quotes: 0, sends: 0 });
  });

  it("starts nothing when the company can't be signed in, and sweeps once it can", async () => {
    // #given a balance to sweep and a sign-in Privy refuses
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    privy.state.nextNearSignings("refused");

    // #when the sweep runs
    const refused = await sweep();

    // #then no quote was saved and nothing was sent
    expect({
      refused,
      sweeps: (await sweeps()).length,
      sends: transitSends().length,
    }).toEqual({ refused: null, sweeps: 0, sends: 0 });

    // #when it runs again with sign-in working
    const retried = await sweep();

    // #then it sweeps
    expect(retried?.status).toBe("depositing");
  });

  it("leaves a saved sweep untouched, sending nothing and telling 1Click nothing, while the company can't be signed in", async () => {
    // #given a saved sweep into the account whose transfer hasn't started,
    // and a company that has not signed in yet
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const saved = await saveQuote(
      runtime,
      db,
      {
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      },
      "sweep",
      { amount: 5n * USDC, row: { recipientType: "CONFIDENTIAL_INTENTS" } },
    );
    const told = oneClick.state.submitted.length;
    privy.state.nextNearSignings("refused");

    // #when it is advanced with no session to be had
    const resumed = await advance(saved);

    // #then it is as it was: nothing sent, 1Click told nothing
    expect({
      status: resumed.status,
      depositStartedAt: resumed.depositStartedAt,
      sends: transitSends().length,
      told: oneClick.state.submitted.length - told,
    }).toEqual({
      status: "quoted",
      depositStartedAt: null,
      sends: 0,
      told: 0,
    });

    // #when the sign-in works again
    const later = await advance(saved);

    // #then it goes ahead
    expect(later.status).toBe("depositing");
  });
});

describe("sweeping the transit wallet of a company whose USDC is in its company wallet", () => {
  it("asks 1Click exactly as before: no confidential field, no session", async () => {
    // #given 5 USDC in the transit wallet
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    const before = oneClick.state.calls.length;

    // #when the sweep runs
    const started = await sweep();
    if (!started) throw new Error("no sweep");

    // #then
    const request = oneClick.state.quotes.get(started.depositAddress)?.request;
    expect({
      recipientType: request?.recipientType,
      depositType: request?.depositType,
      refundType: request?.refundType,
      sessions: oneClick.state.calls
        .slice(before)
        .map((entry) => [entry.call, entry.session]),
      row: [started.recipientType, started.depositType, started.refundType],
    }).toEqual({
      recipientType: undefined,
      depositType: undefined,
      refundType: undefined,
      sessions: [
        ["quote", undefined],
        ["submitDeposit", undefined],
        ["status", undefined],
      ],
      row: ["DESTINATION_CHAIN", "ORIGIN_CHAIN", "ORIGIN_CHAIN"],
    });
  });
});
