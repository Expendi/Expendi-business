import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { payrollRuns } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { sweepTransitWallets } from "../../services/intents/sweep.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { advanceBaseHop } from "../../services/payout/base-hop.js";
import { deliverUsdcPayout } from "../../services/payout/delivery.js";
import { advanceOutboundQuotes } from "../../services/payout/outbound-quotes.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { reconcilePretiumPayouts } from "../../services/payout/pretium-fund.js";
import {
  APPROVAL_LAPSE_MS,
  reconcilePaycrestPayouts,
} from "../../services/payout/sync.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import { randomTxHash } from "../helpers/chain.js";
import { settleOpenQuotes } from "../helpers/confidential-delivery.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import { saveQuote } from "../helpers/money-in.js";
import {
  createNearPayingCompany,
  deliverHop,
  makeNearPayoutWorld,
  readQuotes,
  updateQuote,
} from "../helpers/near-payouts.js";
import {
  allowlistAddress,
  claimRequest,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";

/**
 * The jobs look across every company, so they run here, one file at a time,
 * where no other file's quotes are in the database.
 */

const world = makeNearPayoutWorld();
const { runtime, privy, oneClick, pretium } = world;
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

const job = () => runtime.runPromise(advanceOutboundQuotes(500));

const onlyQuote = async () => {
  const [quote, ...others] = await readQuotes(db, paying.company);
  if (!quote || others.length > 0) throw new Error("expected one quote");
  return quote;
};

describe("the outbound quotes job", () => {
  it("funds a cash-out once its Base hop delivers", async () => {
    // #given a cash-out waiting for its hop
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    const hop = await onlyQuote();
    await job();
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "approved",
    );

    // #when 1Click delivers and the job runs
    deliverHop(world, paying, hop);
    await job();

    // #then the payout is funded from the transit wallet
    expect({
      status: (await readPayout(db, paying.company, payout.id)).status,
      sends: privy.state.sends.filter(
        (send) => send.privyWalletId === paying.transitPrivyWalletId,
      ).length,
    }).toEqual({ status: "paying", sends: 1 });
  });

  it("catches up a cash-out whose hop settled before a crash", async () => {
    // #given a hop already settled as delivered, its payout still approved
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    const hop = await onlyQuote();
    deliverHop(world, paying, hop);
    await runtime.runPromise(advanceBaseHop(hop));

    // #when the job runs
    const summary = await job();

    // #then it funds the payout although the quote is no longer unsettled
    expect({
      status: (await readPayout(db, paying.company, payout.id)).status,
      caughtUp: summary.caughtUp > 0,
    }).toEqual({ status: "paying", caughtUp: true });
  });

  it("marks a USDC payout to another chain paid once 1Click delivers", async () => {
    // #given a USDC payout to Base whose deposit ran
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address, "Supplier", "base");
    const prepared = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [
          {
            subjectType: "bill",
            subjectId: randomUUID(),
            idempotencyKey: `bill:${randomUUID()}:1`,
            recipient: {
              method: "usdc",
              chain: "base",
              address,
              accountName: "Supplier",
            },
            amountUsdc: 25n * USDC,
          },
        ],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: prepared.map((payout) => payout.id),
      }),
    );
    const [approved] = await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );
    if (!approved) throw new Error("nothing approved");
    await runtime.runPromise(deliverUsdcPayout(approved));
    const quote = await onlyQuote();

    // #when 1Click delivers and the job runs
    const destinationTx = randomTxHash();
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [destinationTx],
    });
    await job();

    // #then the payout is paid with the delivery's transaction
    const paid = await readPayout(db, paying.company, approved.id);
    expect({
      status: paid.status,
      reference: paid.providerReference,
    }).toEqual({ status: "paid", reference: destinationTx });
  });
});

describe("the outbound quotes job and a delivery that stopped half-way", () => {
  it("fails an approved USDC payout whose quote expired in a run that stopped before the payout moved", async () => {
    // #given a USDC payout to Base with a saved quote, not yet funded
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address, "Supplier", "base");
    const prepared = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [
          {
            subjectType: "bill",
            subjectId: randomUUID(),
            idempotencyKey: `bill:${randomUUID()}:1`,
            recipient: {
              method: "usdc",
              chain: "base",
              address,
              accountName: "Supplier",
            },
            amountUsdc: 25n * USDC,
          },
        ],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: prepared.map((payout) => payout.id),
      }),
    );
    const [approved] = await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );
    if (!approved) throw new Error("nothing approved");
    world.near.state.failNext("usdcStorageRegistered");
    await runtime.runPromise(deliverUsdcPayout(approved));
    const quote = await onlyQuote();
    expect(quote.status).toBe("quoted");

    // #given a run that expired the quote and stopped there: the quote is
    // settled, so no quote lookup returns it, and the payout is still approved
    await updateQuote(db, paying.company, quote.id, {
      status: "expired",
      settledAt: new Date(),
      failure:
        "The quote's deadline came before the deposit could start. Nothing moved.",
    });
    expect((await readPayout(db, paying.company, approved.id)).status).toBe(
      "approved",
    );

    // #when the next run of the job comes
    const summary = await job();

    // #then it finds the payout through the payout lookup and fails it,
    // with nothing sent
    const failed = await readPayout(db, paying.company, approved.id);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      fundingStarted: failed.fundingStartedAt,
      caughtUp: summary.caughtUp > 0,
      companyHolds: world.near.state.usdcBalanceOf(paying.accountId),
    }).toEqual({
      status: "failed",
      reason:
        "The quote's deadline came before the deposit could start. Nothing moved. Nothing was sent.",
      fundingStarted: null,
      caughtUp: true,
      companyHolds: 100n * USDC,
    });
  });
});

describe("the outbound quotes job and quotes no payout leads to", () => {
  it("settles a sweep once 1Click delivers it", async () => {
    // #given a sweep under way
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);
    await runtime.runPromise(sweepTransitWallets());
    const sweep = await onlyQuote();
    expect(sweep.status).toBe("depositing");

    // #when 1Click delivers to the company wallet and the job runs
    oneClick.state.setStatus(sweep.depositAddress, {
      status: "SUCCESS",
      nearTxHashes: [randomTxHash()],
    });
    await job();

    // #then the sweep is settled
    expect((await onlyQuote()).status).toBe("succeeded");
  });
});

describe("the sweep job", () => {
  it("sweeps each company's transit wallet once", async () => {
    // #given two companies with USDC left in their transit wallets
    const other = await createNearPayingCompany(world, db);
    world.setBaseUsdc(paying.transitAddress, 4n * USDC);
    world.setBaseUsdc(other.transitAddress, 7n * USDC);

    // #when the job runs twice
    await runtime.runPromise(sweepTransitWallets());
    await runtime.runPromise(sweepTransitWallets());

    // #then each was swept with one transfer of its own balance
    const sent = (company: NearPayingCompany) =>
      privy.state.sends
        .filter((send) => send.privyWalletId === company.transitPrivyWalletId)
        .map((send) => send.amount);
    expect({ first: sent(paying), second: sent(other) }).toEqual({
      first: [4n * USDC],
      second: [7n * USDC],
    });
  });
});

describe("reconciliation and a cash-out waiting for its hop", () => {
  const longAgo = () => new Date(Date.now() - APPROVAL_LAPSE_MS - 60_000);

  it("leaves the approval alone while the hop is still moving its USDC", async () => {
    // #given a cash-out approved long ago whose hop is still depositing
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    await updatePayout(db, paying.company, payout.id, {
      approvedAt: longAgo(),
    });

    // #when reconciliation runs
    await runtime.runPromise(reconcilePaycrestPayouts(500));

    // #then the approval hasn't lapsed
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "approved",
    );
  });

  it("releases an approval that was never funded long after its hop settled", async () => {
    // #given a hop that delivered long ago and a payout nobody funded
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    const hop = await onlyQuote();
    deliverHop(world, paying, hop);
    await runtime.runPromise(advanceBaseHop(hop));
    await updateQuote(db, paying.company, hop.id, { settledAt: longAgo() });
    await updatePayout(db, paying.company, payout.id, {
      approvedAt: longAgo(),
    });

    // #when reconciliation runs
    await runtime.runPromise(reconcilePaycrestPayouts(500));

    // #then the payout failed with nothing sent; its USDC waits in the
    // transit wallet for the sweep
    const failed = await readPayout(db, paying.company, payout.id);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      orderRequested: failed.orderRequestedAt,
    }).toEqual({
      status: "failed",
      reason: "Funding never started after approval. Nothing was sent.",
      orderRequested: null,
    });
  });
});

describe("a Pretium cash-out waiting for its hop", () => {
  const longAgo = () => new Date(Date.now() - APPROVAL_LAPSE_MS - 60_000);

  beforeEach(async () => {
    pretium.state.reset();
    await mineCompanySends(
      privy,
      world.base.state.receipts,
      db,
      paying.company,
    );
  });

  /** An approved cash-out that approval locked to Pretium, its hop under way. */
  async function approvedForPretium() {
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    await updatePayout(db, paying.company, payout.id, { provider: "pretium" });
    return payout;
  }

  const transitSends = () =>
    privy.state.sends.filter(
      (send) => send.privyWalletId === paying.transitPrivyWalletId,
    );

  it("is funded, once, by the job when its hop settled before a crash", async () => {
    // #given a hop already settled as delivered, its payout still approved
    const payout = await approvedForPretium();
    const hop = await onlyQuote();
    deliverHop(world, paying, hop);
    await runtime.runPromise(advanceBaseHop(hop));

    // #when the job runs, and runs again
    const summary = await job();
    await job();

    // #then it was sent and Pretium told exactly once
    expect({
      status: (await readPayout(db, paying.company, payout.id)).status,
      caughtUp: summary.caughtUp > 0,
      sends: transitSends().length,
      pays: pretium.state.payRequests.filter(
        (request) => request.reference === payout.id,
      ).length,
    }).toEqual({ status: "paying", caughtUp: true, sends: 1, pays: 1 });
  });

  it("is left alone by reconciliation while the hop is still moving its USDC", async () => {
    // #given
    const payout = await approvedForPretium();
    await updatePayout(db, paying.company, payout.id, {
      approvedAt: longAgo(),
    });

    // #when
    await runtime.runPromise(reconcilePretiumPayouts(500));

    // #then
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "approved",
    );
  });

  it("is released by reconciliation when never funded long after its hop settled", async () => {
    // #given
    const payout = await approvedForPretium();
    const hop = await onlyQuote();
    deliverHop(world, paying, hop);
    await runtime.runPromise(advanceBaseHop(hop));
    await updateQuote(db, paying.company, hop.id, { settledAt: longAgo() });
    await updatePayout(db, paying.company, payout.id, {
      approvedAt: longAgo(),
    });

    // #when
    await runtime.runPromise(reconcilePretiumPayouts(500));

    // #then the payout failed with nothing sent; its USDC waits in the
    // transit wallet for the sweep
    const failed = await readPayout(db, paying.company, payout.id);
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: transitSends().length,
      pays: pretium.state.payRequests.filter(
        (request) => request.reference === payout.id,
      ).length,
    }).toEqual({
      status: "failed",
      reason: "Funding never started after approval. Nothing was sent.",
      sends: 0,
      pays: 0,
    });
  });
});

describe("the outbound quotes job for a company whose USDC is in a confidential account", () => {
  let funded: FundedCompany;

  beforeEach(async () => {
    paying = await createNearPayingCompany(world, db, {
      balanceHome: "confidential_account",
    });
    await mineCompanySends(
      privy,
      world.base.state.receipts,
      db,
      paying.company,
    );
    oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
    funded = {
      company: paying.company,
      walletId: paying.wallet.id,
      accountId: paying.accountId,
      transitAddress: paying.transitAddress,
    };
    await saveQuote(runtime, db, funded, "fee_cover", {
      amount: 2n * USDC,
      row: { status: "succeeded", settledAt: new Date() },
    });
  });

  afterEach(async () => {
    await settleOpenQuotes(db, funded);
  });

  async function payroll(salaries: number) {
    const payrollRunId = randomUUID();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId, role: "admin" },
      (tx) =>
        tx.insert(payrollRuns).values({
          id: payrollRunId,
          organizationId: paying.company.organizationId,
          payDate: "2026-11-25",
          totalKes: 150_000n * BigInt(salaries),
          capKes: 540_000n,
        }),
    );
    return payClaims(
      runtime,
      db,
      paying,
      Array.from({ length: salaries }, () =>
        claimRequest({
          subjectType: "bill",
          payrollRunId,
          idempotencyKey: `salary:${randomUUID()}:1`,
          amountKesCents: 150_000n,
        }),
      ),
    );
  }

  const hops = async () =>
    (await readQuotes(db, paying.company)).filter(
      (quote) => quote.purpose === "base_hop",
    );

  it("funds each cash-out of a payroll run once the one hop out of the account succeeds", async () => {
    // #given a run of two salaries hopped once, out of the account
    const batch = await payroll(2);
    const [hop, ...others] = await hops();
    if (!hop || others.length > 0) throw new Error("expected one hop");
    await job();
    expect(
      (
        await Promise.all(
          batch.map((p) => readPayout(db, paying.company, p.id)),
        )
      ).map((payout) => payout.status),
    ).toEqual(["approved", "approved"]);

    // #when 1Click delivers and the job runs, twice
    oneClick.state.deliverIntentPayout(hop.depositAddress);
    world.setBaseUsdc(paying.transitAddress, hop.amountOut);
    await job();
    await job();

    // #then each salary was funded from the transit wallet, once
    const funded = await Promise.all(
      batch.map((p) => readPayout(db, paying.company, p.id)),
    );
    expect({
      statuses: funded.map((payout) => payout.status),
      sends: privy.state.sends
        .filter((send) => send.privyWalletId === paying.transitPrivyWalletId)
        .map((send) => send.idempotencyKey)
        .sort(),
      intents: oneClick.state.submittedIntents.filter(
        (intent) => intent.depositAddress === hop.depositAddress,
      ).length,
    }).toEqual({
      statuses: ["paying", "paying"],
      sends: batch.map((payout) => `payout-${payout.id}`).sort(),
      intents: 1,
    });
  });

  it("fails every cash-out with no ledger row when the job hears the shared hop was refunded", async () => {
    // #given a run whose hop 1Click refunded
    const batch = await payroll(2);
    const [hop] = await hops();
    if (!hop) throw new Error("no hop");
    oneClick.state.refundIntentPayout(hop.depositAddress);

    // #when the job runs, twice
    await job();
    await job();

    // #then
    expect({
      statuses: (
        await Promise.all(
          batch.map((p) => readPayout(db, paying.company, p.id)),
        )
      ).map((payout) => payout.status),
      hop: (await hops())[0]?.status,
      ledger: await ledgerBalance(db, paying.company),
      sends: privy.state.sends.filter(
        (send) => send.privyWalletId === paying.transitPrivyWalletId,
      ).length,
    }).toEqual({
      statuses: ["failed", "failed"],
      hop: "refunded",
      ledger: 100n * USDC,
      sends: 0,
    });
  });

  it("sweeps what is left in the transit wallet into the account, and the job settles it without a ledger row", async () => {
    // #given 5 USDC left in the transit wallet
    world.setBaseUsdc(paying.transitAddress, 5n * USDC);

    // #when the sweep job runs, 1Click delivers and the quotes job runs
    await runtime.runPromise(sweepTransitWallets());
    const [sweep, ...others] = (await readQuotes(db, paying.company)).filter(
      (quote) => quote.purpose === "sweep",
    );
    if (!sweep || others.length > 0) throw new Error("expected one sweep");
    oneClick.state.setStatus(sweep.depositAddress, {
      status: "SUCCESS",
      depositedAmount: sweep.amountIn,
      amountIn: sweep.amountIn,
      amountOut: sweep.amountOut,
    });
    world.setBaseUsdc(paying.transitAddress, 0n);
    await job();

    // #then it delivered into the account and settled, and the ledger holds
    // only the opening deposit
    const settled = (await readQuotes(db, paying.company)).find(
      (quote) => quote.id === sweep.id,
    );
    expect({
      recipientType: sweep.recipientType,
      status: settled?.status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      recipientType: "CONFIDENTIAL_INTENTS",
      status: "succeeded",
      ledger: 100n * USDC,
    });
  });
});
