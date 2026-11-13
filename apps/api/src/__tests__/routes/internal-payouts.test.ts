import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ResolveOutcome } from "@expendi-business/shared";
import {
  payoutQueueResponseSchema,
  payoutRefetchResponseSchema,
  resolveConfirmedSchema,
  resolvePreparedSchema,
  staffPayoutDetailSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcTransfer } from "../../services/chain/base.js";
import type { PaycrestOrder } from "../../services/paycrest/paycrest-client.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePrivyWallets,
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  allowlistAddress,
  claimRequest,
  createPayingCompany,
  ledgerBalance,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let otherAdmin: TestStaff;
let viewer: TestStaff;
let paying: PayingCompany;

const REASON = "Checked Paycrest's dashboard and Basescan by hand.";
const HOUR_MS = 60 * 60_000;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, otherAdmin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
});

afterEach(() => {
  vi.useRealTimers();
});

// Fixtures

/**
 * A Paycrest payout whose send had an unknown outcome: under review, with
 * funding started `fundedAgoMs` ago and its order's deposit window closed,
 * and no ledger debit.
 */
async function stuckPayout(fundedAgoMs = 2 * HOUR_MS): Promise<Payout> {
  privy.state.nextSends("unknown");
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (payout?.status !== "needs_review") {
    throw new Error(`expected needs_review, got ${payout?.status}`);
  }
  await updatePayout(db, paying.company, payout.id, {
    fundingStartedAt: new Date(Date.now() - fundedAgoMs),
    depositValidUntil: new Date(Date.now() - HOUR_MS),
  });
  return readPayout(db, paying.company, payout.id);
}

/** A Paycrest payout that was sent and debited, then put under review. */
async function sentPayoutUnderReview(): Promise<Payout> {
  const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (payout?.status !== "paying") throw new Error("payout isn't paying");
  await updatePayout(db, paying.company, payout.id, {
    status: "needs_review",
    failureReason: "Paycrest marked the order expired after the USDC was sent.",
  });
  return readPayout(db, paying.company, payout.id);
}

/**
 * A USDC payout sent from a company wallet on Base, before NEAR became the
 * main chain, whose send had an unknown outcome: under review, with funding
 * started two hours ago and no ledger debit.
 */
async function stuckUsdcPayout(): Promise<Payout> {
  const address = randomAddress();
  await allowlistAddress(runtime, paying, address);
  const [prepared] = await runtime.runPromise(
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
            accountName: "Acme Ltd",
          },
          amountUsdc: 25n * USDC,
        },
      ],
    }),
  );
  if (!prepared) throw new Error("nothing was prepared");
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      payoutIds: [prepared.id],
    }),
  );
  await runtime.runPromise(
    approvePayouts({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
  await updatePayout(db, paying.company, prepared.id, {
    status: "needs_review",
    fundingStartedAt: new Date(Date.now() - 2 * HOUR_MS),
    depositAddress: address,
    amountToTransferUsdc: prepared.quotedUsdc,
    failureReason:
      "The transfer's outcome is unknown. Check the chain before doing anything; never send again.",
  });
  return readPayout(db, paying.company, prepared.id);
}

function setOrder(payout: Payout, changes: Partial<PaycrestOrder>): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, { ...order, ...changes });
}

/** A USDC transfer from the company wallet to the payout's deposit address. */
function transferOnChain(payout: Payout, amount?: bigint): UsdcTransfer {
  const transfer: UsdcTransfer = {
    from: paying.wallet.address.toLowerCase(),
    to: (payout.depositAddress ?? "").toLowerCase(),
    amount: amount ?? payout.amountToTransferUsdc ?? 0n,
    logIndex: 7,
    blockNumber: rpc.state.latestBlock - 100n,
    txHash: randomTxHash(),
  };
  rpc.state.transfers.push(transfer);
  return transfer;
}

async function refundReceived(payout: Payout, amount: bigint): Promise<void> {
  await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: paying.company.organizationId,
        walletId: paying.wallet.id,
        type: "refund",
        usdcAmount: amount,
        txHash: randomTxHash(),
        logIndex: 2,
        blockNumber: 2n,
        counterpartyAddress: randomAddress(),
        payoutId: payout.id,
      }),
  );
}

interface LedgerRow {
  type: string;
  usdc_amount: string;
  tx_hash: string | null;
}

/** Read in the company's scope: the ledger is FORCE row-level security. */
async function ledgerFor(payoutId: string): Promise<LedgerRow[]> {
  const rows = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({
          type: walletTransactions.type,
          usdcAmount: walletTransactions.usdcAmount,
          txHash: walletTransactions.txHash,
        })
        .from(walletTransactions)
        .where(eq(walletTransactions.payoutId, payoutId))
        .orderBy(walletTransactions.createdAt),
  );
  return rows.map((row) => ({
    type: row.type,
    usdc_amount: row.usdcAmount.toString(),
    tx_hash: row.txHash,
  }));
}

async function auditEntries(payoutId: string, action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    organization_id: string;
    before: unknown;
    after: Record<string, unknown>;
  }>(
    `SELECT actor_type, actor_id, organization_id, before, after
     FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 AND action = $2`,
    [payoutId, action],
  );
  return rows;
}

// HTTP

async function post(
  path: string,
  staff: TestStaff,
  body: unknown = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, staff: TestStaff = viewer): Promise<Response> {
  return app.request(path, { headers: bearer(staff.privyUserId) });
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { _tag: string; message: string };
  };
  return body.error;
}

const prepare = (
  payout: Payout,
  outcome: ResolveOutcome,
  reason = REASON,
  staff = admin,
) =>
  post(`/internal/payouts/${payout.id}/resolve/prepare`, staff, {
    outcome,
    reason,
  });

const confirm = (payoutId: string, token: string, staff = admin) =>
  post(`/internal/payouts/${payoutId}/resolve/confirm`, staff, { token });

async function tokenFor(
  payout: Payout,
  outcome: ResolveOutcome,
  reason = REASON,
): Promise<string> {
  const response = await prepare(payout, outcome, reason);
  expect(response.status).toBe(201);
  return resolvePreparedSchema.parse(await dataOf(response)).token;
}

describe("GET /internal/payouts", () => {
  it("lists one company's payouts under review and failed, for a viewer", async () => {
    // #given
    const review = await stuckPayout();
    paycrest.state.nextCreateFailure = "refused";
    const [failed] = await payClaims(runtime, db, paying, [claimRequest()]);
    await payClaims(runtime, db, paying, [claimRequest()]);

    // #when
    const response = await get(
      `/internal/payouts?companyId=${paying.company.organizationId}`,
    );

    // #then
    expect(response.status).toBe(200);
    const { payouts } = payoutQueueResponseSchema.parse(await dataOf(response));
    expect(payouts.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: failed?.id, status: "failed" },
      { id: review.id, status: "needs_review" },
    ]);
    expect(payouts[1]).toMatchObject({
      organization: {
        id: paying.company.organizationId,
        name: paying.company.name,
      },
      subjectType: "claim",
      providerOrderId: review.providerOrderId,
      depositAddress: review.depositAddress,
      failureReason: review.failureReason,
    });
  });

  it("filters by status and pages newest first", async () => {
    // #given
    const older = await stuckPayout();
    const newer = await stuckPayout();
    const base = `/internal/payouts?status=needs_review&companyId=${paying.company.organizationId}&limit=1`;

    // #when
    const first = payoutQueueResponseSchema.parse(
      await dataOf(await get(base)),
    );
    const second = payoutQueueResponseSchema.parse(
      await dataOf(await get(`${base}&cursor=${first.nextCursor ?? ""}`)),
    );

    // #then
    expect(first.payouts.map((payout) => payout.id)).toEqual([newer.id]);
    expect(second.payouts.map((payout) => payout.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("shows nothing from another company when filtered by one", async () => {
    // #given
    await stuckPayout();
    const other = await createPayingCompany(runtime, db);

    // #when
    const response = await get(
      `/internal/payouts?companyId=${other.company.organizationId}`,
    );

    // #then
    expect(
      payoutQueueResponseSchema.parse(await dataOf(response)).payouts,
    ).toEqual([]);
  });

  it("refuses the company's own admin, who isn't staff", async () => {
    // #when
    const response = await app.request("/internal/payouts", {
      headers: bearer(paying.company.admin.privyUserId),
    });

    // #then
    expect(response.status).toBe(403);
  });
});

describe("GET /internal/payouts/:id", () => {
  it("shows the payout, its masked recipient, ledger and audit trail", async () => {
    // #given
    const payout = await sentPayoutUnderReview();

    // #when
    const response = await get(`/internal/payouts/${payout.id}`);

    // #then
    expect(response.status).toBe(200);
    const detail = staffPayoutDetailSchema.parse(await dataOf(response));
    expect(detail).toMatchObject({
      id: payout.id,
      status: "needs_review",
      recipient: { name: "Jane Wanjiku", detail: "•••• 5678" },
      walletAddress: paying.wallet.address,
      ledger: [
        {
          type: "payout",
          chain: "base",
          usdcAmount: `-${payout.amountToTransferUsdc}`,
        },
      ],
    });
    expect(detail.auditTrail.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["payout.approved", "payout.funded"]),
    );
  });

  it.each(["not-a-uuid", randomUUID()])(
    "returns 404 for %s",
    async (payoutId) => {
      // #when
      const response = await get(`/internal/payouts/${payoutId}`);

      // #then
      expect(response.status).toBe(404);
    },
  );
});

describe("POST /internal/payouts/:id/refetch", () => {
  it("records Paycrest's status on a payout under review without changing it, audited as staff", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "settled" });

    // #when
    const response = await post(
      `/internal/payouts/${payout.id}/refetch`,
      admin,
    );

    // #then
    expect(response.status).toBe(200);
    expect(payoutRefetchResponseSchema.parse(await dataOf(response))).toEqual({
      previousStatus: "needs_review",
      status: "needs_review",
      providerStatus: "settled",
    });
    expect(await readPayout(db, paying.company, payout.id)).toMatchObject({
      status: "needs_review",
      providerStatus: "settled",
    });
    expect(await auditEntries(payout.id, "payout.refetched")).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        actor_id: admin.staffUserId,
        organization_id: paying.company.organizationId,
        after: {
          status: "needs_review",
          paycrestStatus: "settled",
          changed: false,
        },
      }),
    ]);
  });

  it("moves a payout forward through the ordinary sync, sending nothing", async () => {
    // #given
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    setOrder(payout, { status: "settled", paymentReference: "SKL3ABCDEF" });
    const sends = privy.state.sends.length;
    const orders = paycrest.state.created.length;

    // #when
    const response = await post(
      `/internal/payouts/${payout.id}/refetch`,
      admin,
    );

    // #then
    expect(payoutRefetchResponseSchema.parse(await dataOf(response))).toEqual({
      previousStatus: "paying",
      status: "paid",
      providerStatus: "settled",
    });
    const paid = await auditEntries(payout.id, "payout.paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      actor_type: "system",
      after: { source: "staff" },
    });
    expect(privy.state.sends).toHaveLength(sends);
    expect(paycrest.state.created).toHaveLength(orders);
  });

  it("refuses when Paycrest is down, changing nothing", async () => {
    // #given
    const payout = await stuckPayout();
    paycrest.state.failGetOrder = true;

    // #when
    const response = await post(
      `/internal/payouts/${payout.id}/refetch`,
      admin,
    );

    // #then
    expect(response.status).toBe(503);
    expect(await auditEntries(payout.id, "payout.refetched")).toEqual([]);
  });

  it("refuses a USDC payout, which has no Paycrest order", async () => {
    // #given
    const payout = await stuckUsdcPayout();

    // #when
    const response = await post(
      `/internal/payouts/${payout.id}/refetch`,
      admin,
    );

    // #then
    expect(response.status).toBe(409);
  });
});

describe("viewers on payout actions", () => {
  it("refuses an ops viewer every action, changing nothing", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const token = await tokenFor(payout, "failed");

    // #when
    const responses = await Promise.all([
      post(`/internal/payouts/${payout.id}/refetch`, viewer),
      prepare(payout, "failed", REASON, viewer),
      confirm(payout.id, token, viewer),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "needs_review",
    );
  });
});

describe("resolving: the second confirmation", () => {
  it("refuses a confirmation that was never prepared", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });

    // #when
    const response = await confirm(payout.id, "made-up-token");

    // #then
    expect(response.status).toBe(400);
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "needs_review",
    );
  });

  it("changes nothing until confirmed", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });

    // #when
    await tokenFor(payout, "failed");

    // #then
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "needs_review",
    );
    expect(await auditEntries(payout.id, "payout.resolved")).toEqual([]);
  });

  it("applies once: the same token is refused the second time", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const token = await tokenFor(payout, "failed");

    // #when
    const first = await confirm(payout.id, token);
    const second = await confirm(payout.id, token);

    // #then
    expect(first.status).toBe(200);
    expect(second.status).toBe(410);
    expect((await errorOf(second)).message).toBe(
      "This confirmation was already used.",
    );
    expect(await auditEntries(payout.id, "payout.resolved")).toHaveLength(1);
  });

  it("refuses an expired token", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const token = await tokenFor(payout, "failed");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(410);
    expect((await errorOf(response)).message).toBe(
      "This confirmation expired. Start again.",
    );
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "needs_review",
    );
  });

  it("is bound to its payout", async () => {
    // #given
    const payout = await stuckPayout();
    const other = await stuckPayout();
    setOrder(payout, { status: "expired" });
    setOrder(other, { status: "expired" });
    const token = await tokenFor(payout, "failed");

    // #when
    const elsewhere = await confirm(other.id, token);
    const here = await confirm(payout.id, token);

    // #then
    expect(elsewhere.status).toBe(400);
    expect((await readPayout(db, paying.company, other.id)).status).toBe(
      "needs_review",
    );
    expect(here.status).toBe(200);
  });

  it("is bound to the staff member who prepared it", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const token = await tokenFor(payout, "failed");

    // #when
    const byOther = await confirm(payout.id, token, otherAdmin);
    const byPreparer = await confirm(payout.id, token);

    // #then
    expect(byOther.status).toBe(403);
    expect(byPreparer.status).toBe(200);
    expect(await auditEntries(payout.id, "payout.resolved")).toEqual([
      expect.objectContaining({ actor_id: admin.staffUserId }),
    ]);
  });

  it("applies the outcome and reason it was prepared with, not a later one", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const first = await tokenFor(payout, "failed", "First look: never funded.");
    await tokenFor(payout, "failed", "Second look: a different note.");

    // #when
    const response = await confirm(payout.id, first);

    // #then
    expect(response.status).toBe(200);
    const [entry] = await auditEntries(payout.id, "payout.resolved");
    expect(entry?.after).toMatchObject({
      resolution: "failed",
      note: "First look: never funded.",
    });
  });

  it("refuses a stored confirmation whose outcome no longer matches its hash", async () => {
    // #given a forged row: a real paid confirmation's hash, its outcome changed to failed
    const payout = await stuckPayout();
    setOrder(payout, { status: "settled" });
    transferOnChain(payout);
    await tokenFor(payout, "paid");
    const forgedToken = randomUUID();
    await owner.query(
      `INSERT INTO staff_confirmations
         (staff_user_id, purpose, target, params, token_hash, intent_hash, expires_at)
       SELECT staff_user_id, purpose, target,
              jsonb_build_object('outcome', 'failed', 'reason', params ->> 'reason'),
              $1, intent_hash, expires_at
       FROM staff_confirmations WHERE target = $2`,
      [createHash("sha256").update(forgedToken).digest("hex"), payout.id],
    );

    // #when
    const response = await confirm(payout.id, forgedToken);

    // #then
    expect(response.status).toBe(400);
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "needs_review",
    );
  });

  it("can't be edited or deleted once stored, even by the owner", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    await tokenFor(payout, "failed");

    // #when
    const edit = owner.query(
      "UPDATE staff_confirmations SET params = '{}' WHERE target = $1",
      [payout.id],
    );
    const removal = owner.query(
      "DELETE FROM staff_confirmations WHERE target = $1",
      [payout.id],
    );

    // #then
    await expect(edit).rejects.toMatchObject({ code: "42501" });
    await expect(removal).rejects.toMatchObject({ code: "42501" });
  });

  it("needs a written reason", async () => {
    // #given
    const payout = await stuckPayout();

    // #when
    const response = await prepare(payout, "failed", "  ok  ");

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      "Write why, in at least 10 characters.",
    );
  });
});

describe("resolving: only payouts under review", () => {
  it("refuses a payout that isn't under review, even with full evidence", async () => {
    // #given a paying payout Paycrest settled, its transfer on chain and debited
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");
    setOrder(payout, { status: "settled" });
    transferOnChain(payout);

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "Only a payout under review can be resolved; this one is paying.",
    );
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "paying",
    );
  });

  it("refuses a second resolution once the first applied", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const first = await tokenFor(payout, "failed");
    const second = await tokenFor(payout, "failed");
    await confirm(payout.id, first);

    // #when
    const response = await confirm(payout.id, second);

    // #then
    expect(response.status).toBe(409);
    expect(await auditEntries(payout.id, "payout.resolved")).toHaveLength(1);
  });
});

describe("resolving as paid", () => {
  it("refuses without evidence: Paycrest hasn't settled and nothing is on chain", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(
      "marked paid only once Paycrest reports it validated or settled",
    );
  });

  it("refuses a Paycrest payout Paycrest hasn't settled, even with the transfer on chain", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "refunding" });
    transferOnChain(payout);

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
  });

  it("records exactly one debit for a USDC payout proven on chain", async () => {
    // #given
    const payout = await stuckUsdcPayout();
    const transfer = transferOnChain(payout);
    const before = await ledgerBalance(db, paying.company);
    const token = await tokenFor(payout, "paid");

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(200);
    expect(resolveConfirmedSchema.parse(await dataOf(response))).toMatchObject({
      status: "paid",
      ledgerDebit: { type: "payout", usdcAmount: `-${transfer.amount}` },
    });
    expect(await ledgerFor(payout.id)).toEqual([
      {
        type: "payout",
        usdc_amount: `-${transfer.amount}`,
        tx_hash: transfer.txHash,
      },
    ]);
    expect(await ledgerBalance(db, paying.company)).toBe(
      before - transfer.amount,
    );
    expect(await readPayout(db, paying.company, payout.id)).toMatchObject({
      status: "paid",
      txHash: transfer.txHash,
      providerReference: transfer.txHash,
    });
  });

  it("records the missing debit for a Paycrest payout Paycrest settled", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "settled" });
    const transfer = transferOnChain(payout);
    const token = await tokenFor(payout, "paid");

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(200);
    expect(await ledgerFor(payout.id)).toEqual([
      expect.objectContaining({ usdc_amount: `-${transfer.amount}` }),
    ]);
  });

  it("leaves an existing debit alone and adds none", async () => {
    // #given
    const payout = await sentPayoutUnderReview();
    setOrder(payout, { status: "settled" });
    transferOnChain(payout);
    const ledger = await ledgerFor(payout.id);
    const token = await tokenFor(payout, "paid");

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(200);
    expect(await ledgerFor(payout.id)).toEqual(ledger);
  });

  it("refuses when the ledger has no debit and the transfer isn't on chain", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "settled" });

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(
      "the ledger can't be matched to the chain",
    );
  });

  it("refuses a transfer for another amount than the payout sends", async () => {
    // #given
    const payout = await stuckUsdcPayout();
    transferOnChain(payout, 1n);

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
  });

  it("audits the resolution as the staff member, with the evidence", async () => {
    // #given
    const payout = await stuckUsdcPayout();
    const transfer = transferOnChain(payout);
    const token = await tokenFor(payout, "paid");

    // #when
    const response = await confirm(payout.id, token, admin);

    // #then
    expect(response.status).toBe(200);
    const [entry] = await auditEntries(payout.id, "payout.resolved");
    expect(entry).toMatchObject({
      actor_type: "staff",
      actor_id: admin.staffUserId,
      organization_id: paying.company.organizationId,
      before: { status: "needs_review" },
      after: {
        status: "paid",
        resolution: "paid",
        paycrestStatus: null,
        depositTransfers: [
          {
            chain: "base",
            txHash: transfer.txHash,
            usdcAmount: transfer.amount.toString(),
          },
        ],
        ledgerDebits: [
          expect.objectContaining({ usdcAmount: `-${transfer.amount}` }),
        ],
        via: "admin-app",
        note: REASON,
      },
    });
  });
});

describe("resolving as failed", () => {
  it("closes a payout nothing was sent for, once its order expired", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const token = await tokenFor(payout, "failed");

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(200);
    expect(await readPayout(db, paying.company, payout.id)).toMatchObject({
      status: "failed",
    });
    expect(await ledgerFor(payout.id)).toEqual([]);
  });

  it("refuses while a transfer to the deposit address has no refund", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    transferOnChain(payout);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(
      "no refund has come back",
    );
  });

  it("closes a refunded payout and records the debit its transfer lacked", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "refunded" });
    const transfer = transferOnChain(payout);
    await refundReceived(payout, transfer.amount - 20_000n);
    const before = await ledgerBalance(db, paying.company);
    const token = await tokenFor(payout, "failed");

    // #when
    await confirm(payout.id, token);

    // #then
    expect((await readPayout(db, paying.company, payout.id)).status).toBe(
      "failed",
    );
    expect(await ledgerBalance(db, paying.company)).toBe(
      before - transfer.amount,
    );
    expect((await ledgerFor(payout.id)).map((row) => row.type).sort()).toEqual([
      "payout",
      "refund",
    ]);
  });

  it("refuses when Paycrest has paid the recipient", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "settled" });

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
  });

  it("refuses while a transfer could still land", async () => {
    // #given
    const payout = await stuckPayout(10 * 60_000);
    setOrder(payout, { status: "expired" });

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
  });

  it("refuses while Paycrest's order can still take a deposit", async () => {
    // #given
    const payout = await stuckPayout();
    await updatePayout(db, paying.company, payout.id, {
      depositValidUntil: new Date(Date.now() + HOUR_MS),
    });

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(
      "can still take a deposit",
    );
  });

  it("refuses with a clear message when the chain can't be searched", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    rpc.state.failNextSearches(1);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toMatch(
      /^Couldn't search the chain for the funding transfer .*Nothing was changed; try again shortly\.$/,
    );
  });

  it("sends and orders nothing", async () => {
    // #given
    const payout = await stuckPayout();
    setOrder(payout, { status: "expired" });
    const sends = privy.state.sends.length;
    const orders = paycrest.state.created.length;
    const token = await tokenFor(payout, "failed");

    // #when
    const response = await confirm(payout.id, token);

    // #then
    expect(response.status).toBe(200);
    expect(privy.state.sends).toHaveLength(sends);
    expect(paycrest.state.created).toHaveLength(orders);
  });
});
