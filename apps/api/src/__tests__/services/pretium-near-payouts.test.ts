import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { usdcCovering } from "../../services/paycrest/amounts.js";
import { settleHopPayouts } from "../../services/payout/base-hop.js";
import { continueBaseHop, fundPayout } from "../../services/payout/fund.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import { continuePretiumPayout } from "../../services/payout/pretium-fund.js";
import { syncPretiumPayout } from "../../services/payout/pretium-sync.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import { saveQuote } from "../helpers/money-in.js";
import {
  createNearPayingCompany,
  deliverHop,
  makeNearPayoutWorld,
  readQuotes,
} from "../helpers/near-payouts.js";
import {
  claimRequest,
  ledgerBalance,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";

const world = makeNearPayoutWorld();
const { runtime, privy, pretium, base } = world;
let db: Database;
let paying: NearPayingCompany;

const SHILLINGS = 1_500n;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  pretium.state.reset();
  paying = await createNearPayingCompany(world, db);
  await mineCompanySends(privy, base.state.receipts, db, paying.company);
});

async function approvedPayout(): Promise<Payout> {
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
    status: "approved",
    approvalId: randomUUID(),
    approvedBy: paying.company.admin.id,
    approvedAt: new Date(),
  });
  return reread(prepared);
}

const reread = (payout: Payout) => readPayout(db, paying.company, payout.id);

async function onlyHop(): Promise<IntentQuote> {
  const hops = (await readQuotes(db, paying.company)).filter(
    (quote) => quote.purpose === "base_hop",
  );
  const [hop, ...others] = hops;
  if (!hop || others.length > 0) throw new Error("expected exactly one hop");
  return hop;
}

const transitSends = () =>
  privy.state.sends.filter(
    (send) => send.privyWalletId === paying.transitPrivyWalletId,
  );

/** Approves a cash-out, starts its hop, and lets the hop deliver `held`. */
async function fundedAfterHop(held?: bigint): Promise<Payout> {
  const approved = await approvedPayout();
  const waiting = await runtime.runPromise(
    fundPayout({
      organizationId: paying.company.organizationId,
      payoutId: approved.id,
    }),
  );
  expect({
    status: waiting.status,
    sends: transitSends().length,
    pays: pretium.state.payRequests.length,
  }).toEqual({ status: "approved", sends: 0, pays: 0 });
  const hop = await onlyHop();
  deliverHop(world, paying, hop, held);
  await runtime.runPromise(continueBaseHop(hop));
  return reread(approved);
}

describe("a Pretium cash-out for a company whose money is on NEAR", () => {
  it("hops to the transit wallet, then sends from it to the pinned address and is paid", async () => {
    // #when
    const funded = await fundedAfterHop();
    const usdcAmount = usdcCovering(SHILLINGS * 100n, pretium.state.rate);

    // #then
    expect({
      status: funded.status,
      sends: transitSends().map((send) => ({
        to: send.to,
        amount: send.amount,
        key: send.idempotencyKey,
      })),
      pays: pretium.state.payRequests.map((request) => ({
        amountShillings: request.amountShillings,
        transactionHash: request.transactionHash,
        reference: request.reference,
      })),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      sends: [
        {
          to: PRETIUM_BASE_SETTLEMENT_ADDRESS,
          amount: usdcAmount,
          key: `payout-${funded.id}`,
        },
      ],
      pays: [
        {
          amountShillings: SHILLINGS,
          transactionHash: funded.txHash,
          reference: funded.id,
        },
      ],
      ledger: 100n * USDC - usdcAmount,
    });

    // #when Pretium pays
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "SKN1");
    await runtime.runPromise(
      syncPretiumPayout({
        organizationId: paying.company.organizationId,
        payoutId: funded.id,
        source: "reconcile",
      }),
    );

    // #then
    const paid = await reread(funded);
    expect({
      status: paid.status,
      receipt: paid.providerReference,
    }).toEqual({ status: "paid", receipt: "SKN1" });
  });

  it("goes to review without naming Paycrest when its hop's outcome is unclear", async () => {
    // #given
    const approved = await approvedPayout();
    await runtime.runPromise(
      fundPayout({
        organizationId: paying.company.organizationId,
        payoutId: approved.id,
      }),
    );
    const hop = await onlyHop();

    // #when
    await runtime.runPromise(
      settleHopPayouts({
        quote: { ...hop, status: "needs_review", failure: null },
        fund: () => Effect.dieMessage("an unclear hop funds nothing"),
      }),
    );

    // #then
    const row = await reread(approved);
    expect({
      status: row.status,
      namesPaycrest: /paycrest/i.test(row.failureReason ?? ""),
      sends: transitSends().length,
      pays: pretium.state.payRequests.length,
    }).toEqual({
      status: "needs_review",
      namesPaycrest: false,
      sends: 0,
      pays: 0,
    });
  });

  it("fails with nothing sent when the transit wallet doesn't hold the USDC", async () => {
    // #when the hop reports delivery but the chain shows nothing there
    const failed = await fundedAfterHop(0n);

    // #then
    expect({
      status: failed.status,
      neutral: !/pretium|paycrest/i.test(failed.failureReason ?? ""),
      sends: transitSends().length,
      pays: pretium.state.payRequests.length,
    }).toEqual({ status: "failed", neutral: true, sends: 0, pays: 0 });
  });

  it("credits the refund at the transit wallet and fails the payout with the USDC back", async () => {
    // #given Pretium refused the payment and sent a refund
    pretium.state.nextPayOutcome = "refused";
    const refundHash = randomTxHash();
    pretium.state.nextRefundOutcome = { kind: "success", hash: refundHash };
    const funded = await fundedAfterHop();
    const amount = funded.amountToTransferUsdc ?? 0n;

    // #when it lands in the transit wallet
    const receipt = transferReceipt(
      [
        {
          to: paying.transitAddress,
          amount,
          from: PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase(),
        },
      ],
      { txHash: refundHash },
    );
    base.state.receipts.set(refundHash, receipt);
    await runtime.runPromise(
      creditUsdcDeposits([refundHash], {
        type: "system",
        id: "alchemy-webhook",
      }),
    );
    await runtime.runPromise(
      continuePretiumPayout({
        organizationId: paying.company.organizationId,
        payoutId: funded.id,
      }),
    );
    await runtime.runPromise(
      syncPretiumPayout({
        organizationId: paying.company.organizationId,
        payoutId: funded.id,
        source: "reconcile",
      }),
    );

    // #then
    const credits = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({
            type: walletTransactions.type,
            payoutId: walletTransactions.payoutId,
          })
          .from(walletTransactions)
          .where(
            and(
              eq(
                walletTransactions.organizationId,
                paying.company.organizationId,
              ),
              eq(walletTransactions.txHash, refundHash),
            ),
          ),
    );
    expect({
      credits,
      status: (await reread(funded)).status,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      credits: [{ type: "refund", payoutId: funded.id }],
      status: "failed",
      ledger: 100n * USDC,
    });
  });
});

describe("a Pretium cash-out for a company whose USDC is in a confidential account", () => {
  beforeEach(async () => {
    paying = await createNearPayingCompany(world, db, {
      balanceHome: "confidential_account",
    });
    await mineCompanySends(privy, base.state.receipts, db, paying.company);
    world.oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
    await saveQuote(
      runtime,
      db,
      {
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      },
      "fee_cover",
      {
        amount: 2n * USDC,
        row: { status: "succeeded", settledAt: new Date() },
      },
    );
  });

  async function waitingForHop(): Promise<{
    approved: Payout;
    hop: IntentQuote;
  }> {
    const approved = await approvedPayout();
    const waiting = await runtime.runPromise(
      fundPayout({
        organizationId: paying.company.organizationId,
        payoutId: approved.id,
      }),
    );
    expect({
      status: waiting.status,
      sends: transitSends().length,
      pays: pretium.state.payRequests.length,
    }).toEqual({ status: "approved", sends: 0, pays: 0 });
    return { approved, hop: await onlyHop() };
  }

  it("hops out of the account by a signed message, then pays Pretium from the transit wallet", async () => {
    // #given a cash-out whose hop was paid out of the account
    const { approved, hop } = await waitingForHop();
    expect({
      depositType: hop.depositType,
      refundType: hop.refundType,
      intents: world.oneClick.state.submittedIntents.filter(
        (intent) => intent.depositAddress === hop.depositAddress,
      ).length,
    }).toEqual({
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
      intents: 1,
    });

    // #when 1Click delivers the hop to the transit wallet
    world.oneClick.state.deliverIntentPayout(hop.depositAddress);
    world.setBaseUsdc(paying.transitAddress, hop.amountOut);
    await runtime.runPromise(continueBaseHop(hop));
    await runtime.runPromise(continueBaseHop(hop));

    // #then Pretium is paid once, from the transit wallet, to the pinned
    // address, and the ledger is debited by that payment alone
    const funded = await reread(approved);
    expect({
      status: funded.status,
      sends: transitSends().map((send) => ({
        to: send.to,
        key: send.idempotencyKey,
      })),
      pays: pretium.state.payRequests.length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      sends: [
        {
          to: PRETIUM_BASE_SETTLEMENT_ADDRESS,
          key: `payout-${funded.id}`,
        },
      ],
      pays: 1,
      ledger: 100n * USDC - (funded.amountToTransferUsdc ?? 0n),
    });
  });

  it("fails with nothing sent and no ledger row when 1Click refunds the hop", async () => {
    // #given a hop 1Click refunded into the account
    const { approved, hop } = await waitingForHop();
    world.oneClick.state.refundIntentPayout(hop.depositAddress);

    // #when the job runs
    await runtime.runPromise(continueBaseHop(hop));

    // #then
    const failed = await reread(approved);
    expect({
      status: failed.status,
      neutral: !/pretium|paycrest/i.test(failed.failureReason ?? ""),
      sends: transitSends().length,
      pays: pretium.state.payRequests.length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "failed",
      neutral: true,
      sends: 0,
      pays: 0,
      ledger: 100n * USDC,
    });
  });
});
