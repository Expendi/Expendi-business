import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { KesRecipient } from "../../services/paycrest/recipient.js";
import type { PretiumTransaction } from "../../services/pretium/pretium-client.js";
import type { TransferLogInput } from "../helpers/chain.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { organizations, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { usdcCovering } from "../../services/paycrest/amounts.js";
import { fundPayout } from "../../services/payout/fund.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import {
  continuePretiumPayout,
  PretiumReceiptPolling,
} from "../../services/payout/pretium-fund.js";
import { syncPretiumPayout } from "../../services/payout/pretium-sync.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { refetchPayout } from "../../services/staff/payouts.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import {
  makeFakeBaseRpc,
  makeFakePretium,
  makeFakePrivyWallets,
  randomAddress,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  ledgerBalance,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const pretium = makeFakePretium();
const rpc = makeFakeBaseRpc();
const runtime = makeTestRuntime({
  privyWallets: privy.layer,
  pretium: pretium.layer,
  baseRpc: rpc.layer,
});
let db: Database;
let owner: pg.Pool;
let paying: PayingCompany;

const PINNED = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();
const MINUTE = 60_000;
const ALCHEMY = { type: "system", id: "alchemy-webhook" } as const;
/** What a claim of 1,499.50 KES is paid as: whole shillings. */
const SHILLINGS = 1_500n;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  pretium.state.reset();
  rpc.state.receipts.clear();
  paying = await createPayingCompany(runtime, db);
  await mineCompanySends(privy, rpc.state.receipts, db, paying.company);
});

/**
 * An approved Pretium cash-out, as approval leaves it: the provider is set
 * on the row here, which approval does in production.
 */
async function approvedPayout(
  recipient?: KesRecipient,
  company = paying,
): Promise<Payout> {
  const [prepared] = await runtime.runPromise(
    preparePayouts({
      organizationId: company.company.organizationId,
      actor: { type: "user", id: company.company.admin.id },
      requests: [claimRequest(recipient && { recipient })],
    }),
  );
  if (!prepared) throw new Error("nothing prepared");
  await updatePayout(db, company.company, prepared.id, {
    provider: "pretium",
    status: "approved",
    approvalId: randomUUID(),
    approvedBy: company.company.admin.id,
    approvedAt: new Date(),
  });
  return reread(prepared, company);
}

const reread = (payout: Payout, company = paying) =>
  readPayout(db, company.company, payout.id);

const fund = (payout: Payout, company = paying) =>
  runtime.runPromise(
    fundPayout({
      organizationId: company.company.organizationId,
      payoutId: payout.id,
    }),
  );

const resume = (payout: Payout) =>
  runtime.runPromise(
    continuePretiumPayout({
      organizationId: paying.company.organizationId,
      payoutId: payout.id,
    }),
  );

const sync = (payout: Payout) =>
  runtime.runPromise(
    syncPretiumPayout({
      organizationId: paying.company.organizationId,
      payoutId: payout.id,
      source: "reconcile",
    }),
  );

/**
 * What the minute job does for one payout, `times` over: the continuation,
 * then the sync. The job itself runs every company's payouts, so it is
 * tested in pretium-reconcile.serial.test.ts.
 */
async function step(payout: Payout, times = 1): Promise<void> {
  for (let run = 0; run < times; run += 1) {
    await resume(payout);
    await sync(payout);
  }
}

const ago = (ms: number) => new Date(Date.now() - ms);

const transactionOf = (payout: Payout): PretiumTransaction => {
  const transaction = pretium.state.transactions.get(
    payout.providerOrderId ?? "",
  );
  if (!transaction) throw new Error("Pretium has no transaction for payout");
  return transaction;
};

const paysFor = (payout: Payout) =>
  pretium.state.payRequests.filter(
    (request) => request.reference === payout.id,
  );

async function auditActions(payoutId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 ORDER BY occurred_at, id",
    [payoutId],
  );
  return rows.map((row) => row.action);
}

/** A USDC transfer into the company wallet on Base, credited as Alchemy would. */
async function arrive(transfer: {
  readonly amount: bigint;
  readonly from?: string;
  readonly txHash?: string;
}): Promise<string> {
  const receipt = transferReceipt(
    [
      {
        to: paying.wallet.address,
        amount: transfer.amount,
        from: transfer.from ?? randomAddress().toLowerCase(),
      },
    ],
    { txHash: transfer.txHash ?? randomTxHash() },
  );
  rpc.state.receipts.set(receipt.transactionHash, receipt);
  await runtime.runPromise(
    creditUsdcDeposits([receipt.transactionHash], ALCHEMY),
  );
  return receipt.transactionHash;
}

const creditsOf = (txHash: string) =>
  runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
    tx
      .select({
        type: walletTransactions.type,
        payoutId: walletTransactions.payoutId,
        usdcAmount: walletTransactions.usdcAmount,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.organizationId, paying.company.organizationId),
          eq(walletTransactions.txHash, txHash),
        ),
      ),
  );

/** A funded cash-out whose `pay` Pretium refused, so its refund was asked for. */
async function refundRequested(refundHash: string | null): Promise<Payout> {
  pretium.state.nextPayOutcome = "refused";
  pretium.state.nextRefundOutcome = { kind: "success", hash: refundHash };
  const payout = await fund(await approvedPayout());
  expect(payout.refundRequestedAt).not.toBeNull();
  return payout;
}

describe("funding a Pretium cash-out from a company wallet on Base", () => {
  it("sends the USDC to the pinned settlement address once, tells Pretium the hash, and is paid", async () => {
    // #given
    const approved = await approvedPayout();
    const usdcAmount = usdcCovering(SHILLINGS * 100n, pretium.state.rate);

    // #when
    const funded = await fund(approved);

    // #then exactly one transfer went to the pinned address, and Pretium
    // was told its hash, once, for the whole shillings
    expect({
      status: funded.status,
      sends: privy.state.sends.map((send) => ({
        to: send.to,
        amount: send.amount,
        key: send.idempotencyKey,
      })),
      pays: pretium.state.payRequests,
      saved: {
        providerOrderId: funded.providerOrderId,
        depositAddress: funded.depositAddress,
        usdcAmount: funded.usdcAmount,
        feeUsdc: funded.feeUsdc,
        amountToTransferUsdc: funded.amountToTransferUsdc,
        rate: funded.rate,
      },
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      sends: [
        {
          to: PRETIUM_BASE_SETTLEMENT_ADDRESS,
          amount: usdcAmount,
          key: `payout-${approved.id}`,
        },
      ],
      pays: [
        {
          recipient: {
            type: "MOBILE",
            shortcode: "254712345678",
            mobileNetwork: "Safaricom",
          },
          amountShillings: SHILLINGS,
          transactionHash: funded.txHash,
          reference: approved.id,
        },
      ],
      saved: {
        providerOrderId: pretium.state.byHash(funded.txHash ?? "")
          ?.transactionCode,
        depositAddress: PINNED,
        usdcAmount,
        feeUsdc: 0n,
        amountToTransferUsdc: usdcAmount,
        rate: pretium.state.rate,
      },
      ledger: 100n * USDC - usdcAmount,
    });

    // #when Pretium pays and the job runs, three times over
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "SKL4XYZ");
    await step(funded, 3);

    // #then it is paid with the receipt, and nothing was sent or told again
    const paid = await reread(approved);
    expect({
      status: paid.status,
      providerReference: paid.providerReference,
      paidAt: paid.paidAt !== null,
      sends: privy.state.sends.length,
      pays: paysFor(approved).length,
      refunds: pretium.state.refundCalls.length,
      audit: await auditActions(approved.id),
    }).toEqual({
      status: "paid",
      providerReference: "SKL4XYZ",
      paidAt: true,
      sends: 1,
      pays: 1,
      refunds: 0,
      audit: expect.arrayContaining([
        "payout.funding_started",
        "payout.funded",
        "payout.paid",
      ]) as string[],
    });
  });

  it("is paid on COMPLETED too", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETED", "R1");

    // #when
    await sync(funded);

    // #then
    expect((await reread(funded)).status).toBe("paid");
  });

  it("fails with nothing sent when Pretium can't pay the payee's bank", async () => {
    // #given a bank Pretium has no code for
    const approved = await approvedPayout({
      method: "bank",
      bankCode: "MIEKKENA",
      accountNumber: "0123456789",
      accountName: "Jane Wanjiku",
    });

    // #when
    const failed = await fund(approved);

    // #then
    expect({
      status: failed.status,
      neutral: !/pretium|paycrest/i.test(failed.failureReason ?? ""),
      nothingSent: failed.failureReason?.includes("Nothing was sent"),
      sends: privy.state.sends.length,
      pays: pretium.state.payRequests.length,
    }).toEqual({
      status: "failed",
      neutral: true,
      nothingSent: true,
      sends: 0,
      pays: 0,
    });
  });

  it("fails with nothing sent when there's no rate", async () => {
    // #given
    pretium.state.failRate = true;

    // #when
    const failed = await fund(await approvedPayout());

    // #then
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: privy.state.sends.length,
    }).toEqual({
      status: "failed",
      reason: expect.stringMatching(
        /^Couldn't get a rate for this cash-out: .*Nothing was sent\.$/,
      ) as string,
      sends: 0,
    });
    expect(failed.failureReason).not.toMatch(/pretium|paycrest/i);
  });

  it("fails with nothing sent when the rate moved past the approved maximum", async () => {
    // #given
    pretium.state.rate = "100";

    // #when
    const failed = await fund(await approvedPayout());

    // #then
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: privy.state.sends.length,
    }).toEqual({
      status: "failed",
      reason:
        "The rate moved past what was approved. Approve again at the new rate.",
      sends: 0,
    });
  });

  it("fails with nothing sent when Pretium reports another settlement address", async () => {
    // #given
    pretium.state.settlementAddress = randomAddress().toLowerCase();

    // #when
    const failed = await fund(await approvedPayout());

    // #then
    expect({
      status: failed.status,
      neutral: !/pretium|paycrest/i.test(failed.failureReason ?? ""),
      sends: privy.state.sends.length,
      pays: pretium.state.payRequests.length,
      funding: failed.fundingStartedAt,
    }).toEqual({
      status: "failed",
      neutral: true,
      sends: 0,
      pays: 0,
      funding: null,
    });
  });

  it("fails with nothing sent when Pretium's settlement address can't be read", async () => {
    // #given
    pretium.state.settlementAddress = null;

    // #when
    const failed = await fund(await approvedPayout());

    // #then
    expect({
      status: failed.status,
      sends: privy.state.sends.length,
    }).toEqual({ status: "failed", sends: 0 });
  });

  it("fails with nothing sent when payouts are paused at the barrier", async () => {
    // #given
    const approved = await approvedPayout();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(organizations)
          .set({ payoutsPaused: true })
          .where(eq(organizations.id, paying.company.organizationId)),
    );

    // #when
    const failed = await fund(approved);

    // #then
    expect({
      status: failed.status,
      reason: failed.failureReason,
      sends: privy.state.sends.length,
    }).toEqual({
      status: "failed",
      reason: "Payouts were paused. Nothing was sent.",
      sends: 0,
    });
  });

  it("fails with nothing debited when the wallet refuses the send", async () => {
    // #given
    privy.state.nextSends("refused");

    // #when
    const failed = await fund(await approvedPayout());

    // #then
    expect({
      status: failed.status,
      pays: pretium.state.payRequests.length,
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({ status: "failed", pays: 0, ledger: 100n * USDC });
  });

  it("goes to review, and never sends or tells Pretium again, when the send's outcome is unknown", async () => {
    // #given
    privy.state.nextSends("unknown");

    // #when
    const review = await fund(await approvedPayout());
    await step(review, 2);

    // #then
    expect({
      status: (await reread(review)).status,
      sends: privy.state.sends.length,
      pays: pretium.state.payRequests.length,
    }).toEqual({ status: "needs_review", sends: 1, pays: 0 });
  });
});

describe("a Pretium send whose hash Privy didn't return", () => {
  it("takes the hash from Privy once it has one, then tells Pretium", async () => {
    // #given
    privy.state.nextSends("sent_without_hash");
    const funded = await fund(await approvedPayout());
    expect({
      status: funded.status,
      txHash: funded.txHash,
      pays: pretium.state.payRequests.length,
    }).toEqual({ status: "paying", txHash: null, pays: 0 });

    // #when Privy has the hash by the next run
    const hash = randomTxHash();
    privy.state.confirmTransaction(funded.privyTransactionId ?? "", hash);
    await resume(funded);

    // #then
    const told = await reread(funded);
    expect({
      txHash: told.txHash,
      pays: paysFor(funded).map((request) => request.transactionHash),
      code: told.providerOrderId,
    }).toEqual({
      txHash: hash,
      pays: [hash],
      code: pretium.state.byHash(hash)?.transactionCode,
    });
  });

  it("goes to review without telling Pretium when no hash turns up", async () => {
    // #given
    privy.state.nextSends("sent_without_hash");
    const funded = await fund(await approvedPayout());

    // #when the job runs within the funding window, then after it (funding
    // already looked once)
    await resume(funded);
    const waiting = (await reread(funded)).status;
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(11 * MINUTE),
    });
    await resume(funded);

    // #then
    expect({
      waiting,
      status: (await reread(funded)).status,
      lookups: privy.state.transactionHashLookups.length,
      pays: pretium.state.payRequests.length,
    }).toEqual({
      waiting: "paying",
      status: "needs_review",
      lookups: 3,
      pays: 0,
    });
  });
});

describe("confirming the transfer on Base before telling Pretium", () => {
  /** A cash-out whose transfer Privy sent but Base hasn't mined yet. */
  async function sentUnmined(): Promise<Payout> {
    privy.state.mineOn(null);
    const funded = await fund(await approvedPayout());
    expect({
      status: funded.status,
      claimed: funded.orderRequestedAt !== null,
      pays: paysFor(funded).length,
    }).toEqual({ status: "paying", claimed: false, pays: 0 });
    return funded;
  }

  const ours = (payout: Payout): TransferLogInput => ({
    from: paying.wallet.address,
    to: PINNED,
    amount: payout.amountToTransferUsdc ?? 0n,
  });

  const mine = (
    payout: Payout,
    transfers: readonly TransferLogInput[],
    status = "0x1",
  ) => {
    const txHash = payout.txHash ?? "";
    rpc.state.receipts.set(
      txHash.toLowerCase(),
      transferReceipt(transfers, { txHash, status }),
    );
  };

  it("tells Pretium nothing until Base has mined the transfer, then tells it once", async () => {
    // #given Pretium would refuse a hash it can't see yet
    const funded = await sentUnmined();
    pretium.state.nextPayOutcome = "refused";

    // #when the job runs before the block is mined
    await step(funded, 2);
    const before = await reread(funded);

    // #then nothing was claimed, told or refunded
    expect({
      status: before.status,
      claimed: before.orderRequestedAt !== null,
      pays: paysFor(funded).length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({ status: "paying", claimed: false, pays: 0, refunds: 0 });

    // #when it is mined
    pretium.state.nextPayOutcome = "accepted";
    mine(funded, [ours(funded)]);
    await step(funded, 2);

    // #then
    const told = await reread(funded);
    expect({
      status: told.status,
      pays: paysFor(funded).map((request) => request.transactionHash),
      code: told.providerOrderId,
    }).toEqual({
      status: "paying",
      pays: [funded.txHash],
      code: pretium.state.byHash(funded.txHash ?? "")?.transactionCode,
    });
  });

  it("waits briefly for the receipt in the request that sent it, so Pretium is told then", async () => {
    // #given Base mines the transfer on the third read
    rpc.state.unminedForNext(2);
    const approved = await approvedPayout();

    // #when
    const funded = await runtime.runPromise(
      fundPayout({
        organizationId: paying.company.organizationId,
        payoutId: approved.id,
      }).pipe(
        Effect.provideService(PretiumReceiptPolling, {
          retries: 3,
          interval: 0,
        }),
      ),
    );

    // #then
    expect({
      status: funded.status,
      pays: paysFor(funded).length,
      told: funded.providerOrderId !== null,
    }).toEqual({ status: "paying", pays: 1, told: true });
  });

  it("goes to review, telling Pretium nothing, when the transfer still isn't on Base after ten minutes", async () => {
    // #given
    const funded = await sentUnmined();

    // #when the job runs inside the window, then after it
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(9 * MINUTE),
    });
    await resume(funded);
    const within = (await reread(funded)).status;
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(11 * MINUTE),
    });
    await resume(funded);

    // #then
    const row = await reread(funded);
    expect({
      within,
      status: row.status,
      reason: row.failureReason,
      pays: pretium.state.payRequests.length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({
      within: "paying",
      status: "needs_review",
      reason: expect.stringMatching(
        new RegExp(
          `${funded.txHash ?? ""}.*isn't on Base.*Pretium wasn't told`,
        ),
      ) as string,
      pays: 0,
      refunds: 0,
    });
  });

  it("waits out a Base RPC that can't be read, going to review only after two hours", async () => {
    // #given the receipt can't be read when the transfer is sent
    rpc.state.failNext(1);
    const funded = await fund(await approvedPayout());

    // #when the RPC stays down past the funding window, then past two hours
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(11 * MINUTE),
    });
    rpc.state.failNext(1);
    await resume(funded);
    const afterMinutes = (await reread(funded)).status;
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(121 * MINUTE),
    });
    rpc.state.failNext(1);
    await resume(funded);

    // #then
    const row = await reread(funded);
    expect({
      inline: funded.status,
      afterMinutes,
      status: row.status,
      reason: row.failureReason,
      pays: pretium.state.payRequests.length,
    }).toEqual({
      inline: "paying",
      afterMinutes: "paying",
      status: "needs_review",
      reason: expect.stringContaining("Pretium wasn't told") as string,
      pays: 0,
    });
  });

  it("goes to review, telling Pretium nothing, when the transfer reverted", async () => {
    // #given
    const funded = await sentUnmined();
    mine(funded, [], "0x0");

    // #when
    await step(funded, 2);

    // #then
    const row = await reread(funded);
    expect({
      status: row.status,
      reason: row.failureReason,
      pays: pretium.state.payRequests.length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({
      status: "needs_review",
      reason: expect.stringContaining("reverted") as string,
      pays: 0,
      refunds: 0,
    });
  });

  it.each<[string, (payout: Payout) => TransferLogInput[]]>([
    [
      "a different amount",
      (payout) => [{ ...ours(payout), amount: ours(payout).amount - 1n }],
    ],
    [
      "another recipient",
      (payout) => [{ ...ours(payout), to: randomAddress() }],
    ],
    [
      "another sender",
      (payout) => [{ ...ours(payout), from: randomAddress() }],
    ],
    [
      "two transfers to Pretium",
      (payout) => [ours(payout), { ...ours(payout), logIndex: 1 }],
    ],
    [
      "no USDC in it",
      (payout) => [{ ...ours(payout), contract: randomAddress() }],
    ],
  ])(
    "goes to review, telling Pretium nothing, when the mined transfer has %s",
    async (_, transfers) => {
      // #given
      const funded = await sentUnmined();
      mine(funded, transfers(funded));

      // #when
      await step(funded, 2);

      // #then
      const row = await reread(funded);
      expect({
        status: row.status,
        reason: row.failureReason,
        claimed: row.orderRequestedAt !== null,
        pays: pretium.state.payRequests.length,
        refunds: pretium.state.refundCalls.length,
      }).toEqual({
        status: "needs_review",
        reason: expect.stringContaining("Pretium wasn't told") as string,
        claimed: false,
        pays: 0,
        refunds: 0,
      });
    },
  );
});

describe("telling Pretium about a sent cash-out", () => {
  it("asks for the refund once when Pretium refuses the payment", async () => {
    // #given
    const refundHash = randomTxHash();

    // #when
    const funded = await refundRequested(refundHash);
    await step(funded, 3);

    // #then
    const row = await reread(funded);
    expect({
      status: row.status,
      refundTxHash: row.refundTxHash,
      pays: paysFor(funded).length,
      refunds: pretium.state.refundCalls,
      audit: await auditActions(funded.id),
    }).toEqual({
      status: "paying",
      refundTxHash: refundHash,
      pays: 1,
      refunds: [funded.txHash],
      audit: expect.arrayContaining(["payout.refund_requested"]) as string[],
    });
  });

  it("finds the transaction by hash after an ambiguous reply, without paying again", async () => {
    // #given Pretium took the payment but the reply was lost
    pretium.state.nextPayOutcome = "ambiguous";
    const funded = await fund(await approvedPayout());
    expect({
      code: funded.providerOrderId,
      claimed: funded.orderRequestedAt !== null,
    }).toEqual({ code: null, claimed: true });

    // #when
    await step(funded, 2);

    // #then
    const found = await reread(funded);
    expect({
      code: found.providerOrderId,
      pays: paysFor(funded).length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({
      code: pretium.state.byHash(funded.txHash ?? "")?.transactionCode,
      pays: 1,
      refunds: 0,
    });
  });

  it("goes to review, without paying again, when an ambiguous payment never shows up", async () => {
    // #given the request never reached Pretium
    pretium.state.nextPayOutcome = "ambiguous_lost";
    const funded = await fund(await approvedPayout());

    // #when the job runs within the window, then after it
    await resume(funded);
    await resume(funded);
    const within = (await reread(funded)).status;
    await updatePayout(db, paying.company, funded.id, {
      orderRequestedAt: ago(11 * MINUTE),
    });
    await resume(funded);

    // #then
    expect({
      within,
      status: (await reread(funded)).status,
      pays: paysFor(funded).length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({
      within: "paying",
      status: "needs_review",
      pays: 1,
      refunds: 0,
    });
  });

  it("saves the earlier transaction when Pretium says the hash was already processed", async () => {
    // #given Pretium already has a transaction for the hash when it is told
    privy.state.nextSends("sent_without_hash");
    const funded = await fund(await approvedPayout());
    const hash = randomTxHash();
    privy.state.confirmTransaction(funded.privyTransactionId ?? "", hash);
    pretium.state.transactions.set("TXEARLIER", {
      transactionCode: "TXEARLIER",
      status: "PENDING",
      amount: SHILLINGS.toString(),
      receiptNumber: null,
      publicName: null,
      transactionHash: hash,
      message: null,
    });
    pretium.state.codeByHash.set(hash, "TXEARLIER");

    // #when
    await resume(funded);

    // #then
    const saved = await reread(funded);
    expect({
      code: saved.providerOrderId,
      status: saved.status,
      pays: paysFor(funded).length,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({ code: "TXEARLIER", status: "paying", pays: 1, refunds: 0 });
  });

  it("never asks Pretium to pay again after a crash between the claim and the call", async () => {
    // #given the claim was saved, then the process stopped before `pay`
    privy.state.nextSends("sent_without_hash");
    const funded = await fund(await approvedPayout());
    await updatePayout(db, paying.company, funded.id, {
      txHash: randomTxHash(),
      orderRequestedAt: new Date(),
    });

    // #when the job runs again and again, then after the window
    await step(funded, 3);
    const within = (await reread(funded)).status;
    await updatePayout(db, paying.company, funded.id, {
      orderRequestedAt: ago(11 * MINUTE),
    });
    await step(funded);

    // #then Pretium was only ever searched, never told
    expect({
      within,
      status: (await reread(funded)).status,
      pays: paysFor(funded).length,
      searched: pretium.state.findCalls.length > 0,
    }).toEqual({
      within: "paying",
      status: "needs_review",
      pays: 0,
      searched: true,
    });
  });

  it("asks for the refund once after Pretium reports the payment FAILED", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "FAILED");

    // #when
    await step(funded, 4);

    // #then
    const row = await reread(funded);
    expect({
      status: row.status,
      providerStatus: row.providerStatus,
      refunds: pretium.state.refundCalls,
      claimed: row.refundRequestedAt !== null,
    }).toEqual({
      status: "paying",
      providerStatus: "FAILED",
      refunds: [funded.txHash],
      claimed: true,
    });
  });

  it("goes to review when Pretium refuses the refund, saying the USDC is with Pretium", async () => {
    // #given
    pretium.state.nextPayOutcome = "refused";
    pretium.state.nextRefundOutcome = { kind: "refused" };

    // #when
    const review = await fund(await approvedPayout());
    await step(review, 2);

    // #then
    const row = await reread(review);
    expect({
      status: row.status,
      reason: row.failureReason,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({
      status: "needs_review",
      reason: expect.stringContaining("with Pretium") as string,
      refunds: 1,
    });
  });
});

describe("a refund from Pretium", () => {
  it("is credited by its hash and the payout fails with the USDC back", async () => {
    // #given
    const refundHash = randomTxHash();
    const funded = await refundRequested(refundHash);
    const amount = funded.amountToTransferUsdc ?? 0n;

    // #when the refund lands and the job runs
    await arrive({ amount, txHash: refundHash });
    await step(funded);

    // #then
    const failed = await reread(funded);
    expect({
      credits: await creditsOf(refundHash),
      status: failed.status,
      neutral: !/pretium|paycrest/i.test(failed.failureReason ?? ""),
      ledger: await ledgerBalance(db, paying.company),
    }).toEqual({
      credits: [{ type: "refund", payoutId: funded.id, usdcAmount: amount }],
      status: "failed",
      neutral: true,
      ledger: 100n * USDC,
    });
  });

  it("is matched by the settlement address and amount when Pretium gave no hash", async () => {
    // #given
    const funded = await refundRequested(null);
    const amount = funded.amountToTransferUsdc ?? 0n;

    // #when
    const txHash = await arrive({ amount, from: PINNED });
    await step(funded);

    // #then
    expect({
      credits: await creditsOf(txHash),
      status: (await reread(funded)).status,
    }).toEqual({
      credits: [{ type: "refund", payoutId: funded.id, usdcAmount: amount }],
      status: "failed",
    });
  });

  it("isn't matched by sender alone when the amount differs", async () => {
    // #given
    const funded = await refundRequested(null);
    const amount = (funded.amountToTransferUsdc ?? 0n) - 1n;

    // #when
    const txHash = await arrive({ amount, from: PINNED });
    await step(funded);

    // #then
    expect({
      credits: await creditsOf(txHash),
      status: (await reread(funded)).status,
    }).toEqual({
      credits: [{ type: "deposit", payoutId: null, usdcAmount: amount }],
      status: "paying",
    });
  });

  it("isn't linked to either of two payouts it could be", async () => {
    // #given two refunds of the same amount, neither with a hash
    const first = await refundRequested(null);
    const second = await refundRequested(null);
    expect(second.amountToTransferUsdc).toBe(first.amountToTransferUsdc);
    const amount = first.amountToTransferUsdc ?? 0n;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      // #when
      const txHash = await arrive({ amount, from: PINNED });

      // #then
      expect({
        credits: await creditsOf(txHash),
        first: (await reread(first)).status,
        second: (await reread(second)).status,
        logged: error.mock.calls.some(([message]) =>
          String(message).includes("not linked"),
        ),
      }).toEqual({
        credits: [{ type: "deposit", payoutId: null, usdcAmount: amount }],
        first: "paying",
        second: "paying",
        logged: true,
      });
    } finally {
      error.mockRestore();
    }
  });

  it("goes to review when less comes back than was sent", async () => {
    // #given
    const refundHash = randomTxHash();
    const funded = await refundRequested(refundHash);

    // #when
    await arrive({
      amount: (funded.amountToTransferUsdc ?? 0n) - 10_000n,
      txHash: refundHash,
    });
    await step(funded);

    // #then
    expect((await reread(funded)).status).toBe("needs_review");
  });

  it("goes to review when it hasn't arrived 30 minutes after it was asked for", async () => {
    // #given
    const funded = await refundRequested(randomTxHash());
    await step(funded);
    const waiting = (await reread(funded)).status;

    // #when
    await updatePayout(db, paying.company, funded.id, {
      refundRequestedAt: ago(31 * MINUTE),
    });
    await step(funded);

    // #then
    expect({ waiting, status: (await reread(funded)).status }).toEqual({
      waiting: "paying",
      status: "needs_review",
    });
  });
});

describe("tracking a Pretium cash-out", () => {
  it.each<[string | null, "paid" | "needs_review"]>([
    ["1500", "paid"],
    ["1500.00", "paid"],
    [null, "paid"],
    ["1499", "needs_review"],
    ["1500.5", "needs_review"],
    ["15000", "needs_review"],
    ["1,500", "needs_review"],
  ])(
    "checks the shillings Pretium reports paid (%s) against the cash-out before it is paid",
    async (amount, expected) => {
      // #given
      const funded = await fund(await approvedPayout());
      pretium.state.transactions.set(funded.providerOrderId ?? "", {
        ...transactionOf(funded),
        status: "COMPLETE",
        amount,
        receiptNumber: "SKN1",
      });

      // #when
      await sync(funded);

      // #then
      const row = await reread(funded);
      expect({ status: row.status, reason: row.failureReason }).toEqual({
        status: expected,
        reason:
          expected === "paid"
            ? null
            : (expect.stringMatching(
                new RegExp(`KES ${amount ?? ""}\\b.*KES ${SHILLINGS}\\b`),
              ) as string),
      });
    },
  );

  it("goes to review when Pretium's transaction names another transfer", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.transactions.set(funded.providerOrderId ?? "", {
      ...transactionOf(funded),
      status: "COMPLETE",
      transactionHash: randomTxHash(),
    });

    // #when
    await sync(funded);

    // #then
    expect((await reread(funded)).status).toBe("needs_review");
  });

  it("goes to review when it has been paying too long", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    await updatePayout(db, paying.company, funded.id, {
      fundingStartedAt: ago(2 * 60 * MINUTE + MINUTE),
    });

    // #when
    await sync(funded);

    // #then
    expect((await reread(funded)).status).toBe("needs_review");
  });

  it("is never paid once a refund was asked for", async () => {
    // #given
    pretium.state.nextRefundOutcome = { kind: "success", hash: null };
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "FAILED");
    await step(funded, 2);
    expect((await reread(funded)).refundRequestedAt).not.toBeNull();

    // #when Pretium then reports it complete
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "R2");
    await sync(funded);

    // #then
    expect((await reread(funded)).status).toBe("needs_review");
  });

  it("records a refund Pretium made by itself without asking for one", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "REFUNDED");

    // #when
    await step(funded, 2);

    // #then
    const row = await reread(funded);
    expect({
      status: row.status,
      claimed: row.refundRequestedAt !== null,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({ status: "paying", claimed: true, refunds: 0 });
  });

  it("changes nothing when Pretium's status can't be read", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "R3");
    pretium.state.failStatus = true;

    // #when
    const result = await sync(funded);

    // #then
    expect({
      outcome: result.outcome,
      unavailable: result.statusError !== null,
      status: (await reread(funded)).status,
    }).toEqual({
      outcome: { changed: false },
      unavailable: true,
      status: "paying",
    });
  });

  it("never changes a paid payout when Pretium later reports it FAILED", async () => {
    // #given
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "R4");
    await sync(funded);

    // #when
    pretium.state.settle(funded.providerOrderId ?? "", "FAILED");
    await sync(funded);
    await resume(funded);
    await step(funded);

    // #then
    expect({
      status: (await reread(funded)).status,
      refunds: pretium.state.refundCalls.length,
    }).toEqual({ status: "paid", refunds: 0 });
  });

  it("can be re-fetched by staff through the read-only sync", async () => {
    // #given
    const staff = await createStaff(owner);
    const funded = await fund(await approvedPayout());
    pretium.state.settle(funded.providerOrderId ?? "", "COMPLETE", "R5");

    // #when
    const result = await runtime.runPromise(
      refetchPayout(
        {
          staffUserId: staff.staffUserId,
          email: staff.email,
          role: staff.role,
        },
        funded.id,
      ),
    );

    // #then
    expect({
      result,
      sends: privy.state.sends.length,
      pays: paysFor(funded).length,
    }).toEqual({
      result: {
        previousStatus: "paying",
        status: "paid",
        providerStatus: "COMPLETE",
      },
      sends: 1,
      pays: 1,
    });
  });
});
