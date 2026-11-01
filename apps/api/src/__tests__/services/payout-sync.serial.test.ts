import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { PaycrestOrder } from "../../services/paycrest/paycrest-client.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { retryPayout } from "../../services/payout/payout-service.js";
import {
  APPROVAL_LAPSE_MS,
  FUNDING_STUCK_MS,
  reconcilePaycrestPayouts,
} from "../../services/payout/sync.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { transferReceipt } from "../helpers/chain.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: reconcilePaycrestPayouts sweeps every company's payouts, so run in
// parallel it could move other files' stale payouts (unknown to this file's
// fake Paycrest) to needs_review.

/** Decided by Dennis at Checkpoint B (2026-11-02). */
const TWO_HOURS_MS = 2 * 60 * 60_000;

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
});

/** Pays one claim and returns it in `paying`. */
async function payingPayout(): Promise<Payout> {
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (payout?.status !== "paying") throw new Error("payout isn't paying");
  return payout;
}

function setOrder(payout: Payout, changes: Partial<PaycrestOrder>): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, { ...order, ...changes });
}

const reconcile = () => runtime.runPromise(reconcilePaycrestPayouts(500));
const reload = (payout: Payout) => readPayout(db, paying.company, payout.id);

async function auditActions(payoutId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 ORDER BY occurred_at, id",
    [payoutId],
  );
  return rows.map((row) => row.action);
}

describe("reconciling payouts with Paycrest", () => {
  it("marks a payout paid once Paycrest settles it, with the M-Pesa receipt", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "settled", paymentReference: "SKL3ABCDEF" });

    // #when
    await reconcile();

    // #then
    const paid = await reload(payout);
    expect({
      status: paid.status,
      receipt: paid.providerReference,
      paidAt: paid.paidAt instanceof Date,
    }).toEqual({ status: "paid", receipt: "SKL3ABCDEF", paidAt: true });
  });

  it("counts validated as paid, the point Paycrest says to notify", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "validated" });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("paid");
  });

  it("leaves a payout paying while Paycrest is still working on it", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "fulfilling" });

    // #when
    await reconcile();

    // #then
    const current = await reload(payout);
    expect({ status: current.status, seen: current.providerStatus }).toEqual({
      status: "paying",
      seen: "fulfilling",
    });
  });

  it("updates a payout once, however many times it's reconciled", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "settled" });

    // #when
    await reconcile();
    await reconcile();

    // #then
    const paidEntries = (await auditActions(payout.id)).filter(
      (action) => action === "payout.paid",
    );
    expect(paidEntries).toHaveLength(1);
  });

  it("sends a payout for review if Paycrest expired it after we sent the USDC", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "expired" });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("sends a payout stuck in funding for review, and never sends again", async () => {
    // #given funding started long ago and no outcome was recorded
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      status: "funding",
      txHash: null,
      fundingStartedAt: new Date(Date.now() - FUNDING_STUCK_MS - 60_000),
    });
    const sendsBefore = privy.state.sends.length;

    // #when
    await reconcile();

    // #then
    expect({
      status: (await reload(payout)).status,
      newSends: privy.state.sends.length - sendsBefore,
    }).toEqual({ status: "needs_review", newSends: 0 });
  });

  it("keeps a recently funded payout paying while Paycrest briefly returns 404 for its order", async () => {
    // #given the USDC was sent, then Paycrest 404s the order (c0bc8726 did for ~18 minutes mid-refund)
    const payout = await payingPayout();
    paycrest.state.orders.delete(payout.providerOrderId ?? "");
    const sendsBefore = privy.state.sends.length;

    // #when
    await reconcile();

    // #then
    expect({
      status: (await reload(payout)).status,
      newSends: privy.state.sends.length - sendsBefore,
    }).toEqual({ status: "paying", newSends: 0 });
  });

  it("sends a payout for review when Paycrest has returned 404 for two hours after funding", async () => {
    // #given
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - TWO_HOURS_MS - 60_000),
    });
    paycrest.state.orders.delete(payout.providerOrderId ?? "");
    const sendsBefore = privy.state.sends.length;

    // #when
    await reconcile();

    // #then
    expect({
      status: (await reload(payout)).status,
      newSends: privy.state.sends.length - sendsBefore,
    }).toEqual({ status: "needs_review", newSends: 0 });
  });

  it("sends a payout stuck in funding for review when Paycrest returns 404 for its order", async () => {
    // #given
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      status: "funding",
      txHash: null,
      fundingStartedAt: new Date(Date.now() - FUNDING_STUCK_MS - 60_000),
    });
    paycrest.state.orders.delete(payout.providerOrderId ?? "");

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("keeps a recently started payout funding while Paycrest briefly returns 404 for its order", async () => {
    // #given
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      status: "funding",
      txHash: null,
    });
    paycrest.state.orders.delete(payout.providerOrderId ?? "");

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("funding");
  });

  it("sends a payout still paying two hours after funding for review", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "pending" });
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - TWO_HOURS_MS - 60_000),
    });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("leaves a payout paying when it was funded just under two hours ago", async () => {
    // #given
    const payout = await payingPayout();
    setOrder(payout, { status: "pending" });
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - TWO_HOURS_MS + 5 * 60_000),
    });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("paying");
  });

  it("keeps a recently funded payout paying while Paycrest is briefly unreachable", async () => {
    // #given
    const payout = await payingPayout();
    paycrest.state.failGetOrder = true;

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("paying");
  });

  it("sends a payout for review when Paycrest stays unreachable two hours after funding", async () => {
    // #given
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - TWO_HOURS_MS - 60_000),
    });
    paycrest.state.failGetOrder = true;

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("sends a payout stuck in funding for review while Paycrest is unreachable", async () => {
    // #given
    const payout = await payingPayout();
    await updatePayout(db, paying.company, payout.id, {
      status: "funding",
      txHash: null,
      fundingStartedAt: new Date(Date.now() - FUNDING_STUCK_MS - 60_000),
    });
    paycrest.state.failGetOrder = true;

    // #when
    await reconcile();

    // #then
    expect({
      status: (await reload(payout)).status,
      audited: (await auditActions(payout.id)).at(-1),
    }).toEqual({ status: "needs_review", audited: "payout.needs_review" });
  });

  it("moves funding to paying when Paycrest has our deposit, recording the debit", async () => {
    // #given a send whose result was never recorded, and no debit yet
    const payout = await paidThroughFundingOnly();
    setOrder(payout, { status: "deposited" });

    // #when
    await reconcile();

    // #then
    const current = await reload(payout);
    expect({
      status: current.status,
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({
      status: "paying",
      balance: 100n * USDC - (current.amountToTransferUsdc ?? 0n),
    });
  });

  it("fails an order that expired before it was funded; nothing was sent", async () => {
    // #given an order created but never funded
    const payout = await paidThroughFundingOnly();
    await updatePayout(db, paying.company, payout.id, {
      status: "order_created",
      fundingStartedAt: null,
    });
    setOrder(payout, { status: "expired" });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("failed");
  });

  it("releases an approval whose funding never started", async () => {
    // #given
    const payout = await paidThroughFundingOnly();
    await updatePayout(db, paying.company, payout.id, {
      status: "approved",
      providerOrderId: null,
      orderRequestedAt: null,
      fundingStartedAt: null,
      approvedAt: new Date(Date.now() - APPROVAL_LAPSE_MS - 60_000),
    });

    // #when
    await reconcile();

    // #then
    expect((await reload(payout)).status).toBe("failed");
  });

  it("sends an order request with no answer for review rather than ordering again", async () => {
    // #given an order was requested, but its reply never arrived
    const payout = await paidThroughFundingOnly();
    await updatePayout(db, paying.company, payout.id, {
      status: "approved",
      providerOrderId: null,
      fundingStartedAt: null,
      orderRequestedAt: new Date(Date.now() - 10 * 60_000),
    });
    const ordersBefore = paycrest.state.created.length;

    // #when
    await reconcile();

    // #then
    expect({
      status: (await reload(payout)).status,
      newOrders: paycrest.state.created.length - ordersBefore,
    }).toEqual({ status: "needs_review", newOrders: 0 });
  });

  it("never creates an order or sends money", async () => {
    // #given payouts in every unfinished state
    await payingPayout();
    const ordersBefore = paycrest.state.created.length;
    const sendsBefore = privy.state.sends.length;

    // #when
    await reconcile();
    await reconcile();

    // #then
    expect({
      orders: paycrest.state.created.length - ordersBefore,
      sends: privy.state.sends.length - sendsBefore,
    }).toEqual({ orders: 0, sends: 0 });
  });
});

describe("refunds and retries", () => {
  it("fails a refunded payout and restores the balance from the refund transfer", async () => {
    // #given
    const payout = await payingPayout();
    const fee = payout.feeUsdc ?? 0n;
    const refund = (payout.amountToTransferUsdc ?? 0n) - fee;
    setOrder(payout, { status: "refunded" });
    const receipt = transferReceipt([
      {
        from: payout.depositAddress ?? "",
        to: paying.wallet.address,
        amount: refund,
      },
    ]);
    rpc.state.receipts.set(receipt.transactionHash, receipt);

    // #when Paycrest reports the refund and the USDC arrives on chain
    await reconcile();
    await runtime.runPromise(
      creditUsdcDeposits([receipt.transactionHash], {
        type: "system",
        id: "alchemy-webhook",
      }),
    );

    // #then everything but Paycrest's fee is back
    expect({
      status: (await reload(payout)).status,
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({ status: "failed", balance: 100n * USDC - fee });
  });

  it("records the refund transfer as the payout's refund, not a new deposit", async () => {
    // #given
    const payout = await payingPayout();
    const receipt = transferReceipt([
      {
        from: payout.depositAddress ?? "",
        to: paying.wallet.address,
        amount: 1_000_000n,
      },
    ]);
    rpc.state.receipts.set(receipt.transactionHash, receipt);

    // #when
    await runtime.runPromise(
      creditUsdcDeposits([receipt.transactionHash], {
        type: "system",
        id: "alchemy-webhook",
      }),
    );

    // #then
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({
            type: walletTransactions.type,
            payoutId: walletTransactions.payoutId,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.txHash, receipt.transactionHash)),
    );
    expect(rows).toEqual([{ type: "refund", payoutId: payout.id }]);
  });

  it("retries a failed payout as a new payout with a new key, paid exactly once", async () => {
    // #given a payout that failed with nothing sent
    paycrest.state.nextCreateFailure = "refused";
    const [failed] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (failed?.status !== "failed") throw new Error("payout didn't fail");

    // #when
    const retry = await runtime.runPromise(
      retryPayout({
        organizationId: paying.company.organizationId,
        failedPayoutId: failed.id,
        idempotencyKey: `${failed.idempotencyKey}:retry`,
        actor: { type: "user", id: paying.company.admin.id },
      }),
    );
    if (retry.recipient.method === "usdc") throw new Error("expected KES");
    const [paid] = await payClaims(runtime, db, paying, [
      {
        subjectType: retry.subjectType,
        subjectId: retry.subjectId,
        idempotencyKey: retry.idempotencyKey,
        recipient: retry.recipient,
        amountKesCents: retry.requestedKesCents,
      },
    ]);

    // #then
    expect({
      newPayout: retry.id !== failed.id,
      sameSubject: retry.subjectId === failed.subjectId,
      status: paid?.status,
      sends: privy.state.sends.length,
    }).toEqual({
      newPayout: true,
      sameSubject: true,
      status: "paying",
      sends: 1,
    });
  });

  it("won't retry a payout that hasn't failed", async () => {
    // #given
    const payout = await payingPayout();

    // #when
    const exit = await runtime.runPromiseExit(
      retryPayout({
        organizationId: paying.company.organizationId,
        failedPayoutId: payout.id,
        idempotencyKey: "retry-too-early",
        actor: { type: "user", id: paying.company.admin.id },
      }),
    );

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure?._tag).toBe("PayoutRejected");
  });
});

/**
 * A payout as if funding started but its result was never recorded: status
 * `funding`, no ledger debit yet.
 */
async function paidThroughFundingOnly(): Promise<Payout> {
  privy.state.nextSends("unknown");
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (payout?.status !== "needs_review") {
    throw new Error("expected the send's outcome to be unknown");
  }
  await updatePayout(db, paying.company, payout.id, { status: "funding" });
  return reload(payout);
}
