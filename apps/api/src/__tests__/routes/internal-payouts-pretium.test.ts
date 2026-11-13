import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { ResolveOutcome } from "@expendi-business/shared";
import {
  payoutEvidenceSchema,
  resolveConfirmedSchema,
  resolvePreparedSchema,
  staffPayoutDetailSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcTransfer } from "../../services/chain/base.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { Paycrest } from "../../services/paycrest/paycrest-client.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { isHeldBy } from "../../services/staff/intent-quote-evidence.js";
import { quoteHolding } from "../../services/staff/payout-evidence.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePretium,
  makeFakePrivyWallets,
  randomAddress,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
  readPayout,
  updatePayout,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Staff evidence and resolution for a Pretium cash-out: USDC sent from the
 * transit wallet to Pretium's pinned settlement address, then Pretium told
 * the hash. Pretium is only ever read here.
 */

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
const rpc = makeFakeBaseRpc();
/** Every Paycrest order read, to show a Pretium payout never makes one. */
const paycrestReads: string[] = [];
const countingPaycrest = Layer.effect(
  Paycrest,
  Effect.map(Paycrest, (shape) => ({
    ...shape,
    getOrder: (id: string) => {
      paycrestReads.push(id);
      return shape.getOrder(id);
    },
  })),
).pipe(Layer.provide(paycrest.layer));

const SETTLEMENT = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();
const REASON = "Checked Pretium's dashboard and Basescan by hand.";
const HOUR_MS = 60 * 60_000;

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: countingPaycrest,
    pretium: pretium.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, viewer] = await Promise.all([
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
  pretium.state.reset();
  paycrestReads.length = 0;
  paying = await createPayingCompany(runtime, db);
});

afterEach(() => {
  // Staff only read Pretium: nothing here may pay or ask for a refund.
  expect({
    pay: pretium.state.payRequests,
    refund: pretium.state.refundCalls,
  }).toEqual({ pay: [], refund: [] });
});

// Fixtures

interface PretiumPayoutState {
  /** Whether the USDC reached Pretium's settlement address on Base. */
  readonly sent: boolean;
  /** Whether the payout row records the transfer's hash. */
  readonly hashSaved?: boolean;
  /** Pretium's transaction code, when Pretium was told the hash. */
  readonly code?: string | null;
  readonly depositAddress?: string;
  readonly fundedAgoMs?: number;
}

interface PretiumPayout {
  readonly payout: Payout;
  readonly transfer: UsdcTransfer | null;
}

/**
 * A Pretium cash-out under review, written straight to its row: the
 * Paycrest send path leaves a payout under review with nothing debited,
 * then the row is made Pretium's as E1's funding would leave it.
 */
async function pretiumPayout(
  state: PretiumPayoutState,
): Promise<PretiumPayout> {
  privy.state.nextSends("unknown");
  const [created] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (created?.status !== "needs_review") {
    throw new Error(`expected needs_review, got ${created?.status}`);
  }
  const depositAddress = state.depositAddress ?? SETTLEMENT;
  const amount = created.amountToTransferUsdc ?? 0n;
  const transfer: UsdcTransfer | null = state.sent
    ? {
        from: paying.wallet.address.toLowerCase(),
        to: depositAddress,
        amount,
        logIndex: 4,
        blockNumber: rpc.state.latestBlock - 50n,
        txHash: randomTxHash(),
      }
    : null;
  if (transfer) rpc.state.transfers.push(transfer);
  await updatePayout(db, paying.company, created.id, {
    provider: "pretium",
    providerOrderId: state.code ?? null,
    providerStatus: null,
    depositAddress,
    depositValidUntil: null,
    fundingStartedAt: new Date(Date.now() - (state.fundedAgoMs ?? 2 * HOUR_MS)),
    txHash: transfer && state.hashSaved !== false ? transfer.txHash : null,
    failureReason: "Pretium didn't confirm the cash-out. Check it by hand.",
  });
  return {
    payout: await readPayout(db, paying.company, created.id),
    transfer,
  };
}

/** Pretium's own record of a transaction for `transfer`. */
function pretiumHas(
  code: string,
  transfer: Pick<UsdcTransfer, "txHash">,
  status: string,
): void {
  pretium.state.transactions.set(code, {
    transactionCode: code,
    status,
    amount: "1500",
    receiptNumber: status === "COMPLETE" ? "SKL3PRETIUM" : null,
    publicName: null,
    transactionHash: transfer.txHash.toLowerCase(),
    message: null,
  });
  pretium.state.codeByHash.set(transfer.txHash.toLowerCase(), code);
}

/** Pretium was asked for the refund, and it reached the transit wallet. */
async function refunded(
  payout: Payout,
  amount: bigint | null,
): Promise<string> {
  const refundHash = randomTxHash();
  await updatePayout(db, paying.company, payout.id, {
    refundRequestedAt: new Date(Date.now() - HOUR_MS),
    refundTxHash: refundHash,
  });
  if (amount !== null) {
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx.insert(walletTransactions).values({
          organizationId: paying.company.organizationId,
          walletId: paying.wallet.id,
          type: "refund",
          usdcAmount: amount,
          txHash: refundHash,
          logIndex: 1,
          blockNumber: rpc.state.latestBlock - 10n,
          counterpartyAddress: SETTLEMENT,
          payoutId: payout.id,
        }),
    );
  }
  return refundHash;
}

async function ledgerTypes(payoutId: string): Promise<string[]> {
  const rows = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ type: walletTransactions.type })
        .from(walletTransactions)
        .where(eq(walletTransactions.payoutId, payoutId)),
  );
  return rows.map((row) => row.type).sort();
}

// HTTP

async function get(path: string, staff: TestStaff = viewer): Promise<Response> {
  return app.request(path, { headers: bearer(staff.privyUserId) });
}

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(admin.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

async function evidenceOf(payout: Payout) {
  const response = await get(`/internal/payouts/${payout.id}/evidence`);
  expect(response.status).toBe(200);
  return payoutEvidenceSchema.parse(await dataOf(response));
}

const prepare = (payout: Payout, outcome: ResolveOutcome) =>
  post(`/internal/payouts/${payout.id}/resolve/prepare`, {
    outcome,
    reason: REASON,
  });

async function resolve(payout: Payout, outcome: ResolveOutcome) {
  const prepared = await prepare(payout, outcome);
  expect(prepared.status).toBe(201);
  const { token } = resolvePreparedSchema.parse(await dataOf(prepared));
  const confirmed = await post(
    `/internal/payouts/${payout.id}/resolve/confirm`,
    { token },
  );
  expect(confirmed.status).toBe(200);
  return resolveConfirmedSchema.parse(await dataOf(confirmed));
}

async function auditAfter(payoutId: string): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ after: Record<string, unknown> }>(
    `SELECT after FROM audit_log
     WHERE entity_type = 'payout' AND entity_id = $1 AND action = 'payout.resolved'`,
    [payoutId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.after ?? {};
}

describe("evidence for a Pretium payout", () => {
  it("reads Pretium's transaction by its code, with the transfer to the pinned address", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXCODE01",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXCODE01", transfer, "PROCESSING");

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence).toMatchObject({
      paycrestStatus: null,
      fundingStarted: true,
      depositTransfers: [
        {
          chain: "base",
          txHash: transfer.txHash,
          usdcAmount: transfer.amount.toString(),
        },
      ],
      pretium: {
        settlementAddress: SETTLEMENT,
        depositAddressIsSettlement: true,
        transferHash: transfer.txHash,
        transaction: {
          state: "found",
          lookedUpBy: "code",
          transactionCode: "TXCODE01",
          status: "PROCESSING",
          transactionHash: transfer.txHash.toLowerCase(),
          isThisPayouts: true,
        },
        refundRequestedAt: null,
        refundTxHash: null,
        refundCreditedUsdc: null,
      },
    });
    expect(pretium.state.statusCalls).toEqual(["TXCODE01"]);
    expect(paycrestReads).toEqual([]);
  });

  it("finds Pretium's transaction by the hash when it has no code yet, searching from when funding started", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({ sent: true });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXBYHASH", transfer, "PENDING");

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence.pretium?.transaction).toMatchObject({
      state: "found",
      lookedUpBy: "hash",
      transactionCode: "TXBYHASH",
      status: "PENDING",
      isThisPayouts: true,
    });
    expect(pretium.state.findCalls).toEqual([
      { txHash: transfer.txHash, since: payout.fundingStartedAt },
    ]);
    expect(pretium.state.statusCalls).toEqual([]);
    expect(paycrestReads).toEqual([]);
  });

  it("matches by the transfer found on chain when the payout didn't save its hash", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      hashSaved: false,
    });
    if (!transfer) throw new Error("no transfer");

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence.pretium).toMatchObject({
      transferHash: transfer.txHash,
      transaction: { state: "not_found", lookedUpBy: "hash" },
    });
  });

  it("shows the refund Pretium was asked for and the credit it left in the ledger", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXREFUND",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXREFUND", transfer, "REFUNDED");
    const refundHash = await refunded(payout, transfer.amount);

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    const requested = await readPayout(db, paying.company, payout.id);
    expect(evidence.pretium).toMatchObject({
      refundRequestedAt: requested.refundRequestedAt?.toISOString(),
      refundTxHash: refundHash,
      refundCreditedUsdc: transfer.amount.toString(),
    });
    expect(evidence.refunds).toEqual([
      expect.objectContaining({
        type: "refund",
        txHash: refundHash,
        usdcAmount: transfer.amount.toString(),
      }),
    ]);
  });

  it("reports Pretium as unreadable, not as having no transaction, when it doesn't answer", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXDOWN",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXDOWN", transfer, "COMPLETE");
    pretium.state.failStatus = true;

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence.pretium?.transaction).toEqual({
      state: "unreadable",
      lookedUpBy: "code",
      message: "asked for transaction TXDOWN: TRANSPORT_ERROR",
    });
    expect(paycrestReads).toEqual([]);
  });

  it("asks Pretium nothing when nothing was sent and it has no code", async () => {
    // #given
    const { payout } = await pretiumPayout({ sent: false });

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence).toMatchObject({
      depositTransfers: [],
      pretium: { transferHash: null, transaction: { state: "not_asked" } },
    });
    expect([pretium.state.statusCalls, pretium.state.findCalls]).toEqual([
      [],
      [],
    ]);
  });

  it("gives a Paycrest payout no Pretium evidence and still reads Paycrest", async () => {
    // #given
    privy.state.nextSends("unknown");
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);
    if (!payout) throw new Error("no payout");

    // #when
    const evidence = await evidenceOf(payout);

    // #then
    expect(evidence.pretium).toBeNull();
    expect(evidence.paycrestStatus).not.toBeNull();
    expect(paycrestReads).toEqual([payout.providerOrderId]);
    expect([pretium.state.statusCalls, pretium.state.findCalls]).toEqual([
      [],
      [],
    ]);
  });
});

describe("the payout detail for a Pretium payout", () => {
  it("includes the refund Pretium was asked for", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXDETAIL",
    });
    if (!transfer) throw new Error("no transfer");
    const refundHash = await refunded(payout, null);

    // #when
    const response = await get(`/internal/payouts/${payout.id}`);

    // #then
    expect(response.status).toBe(200);
    const requested = await readPayout(db, paying.company, payout.id);
    expect(staffPayoutDetailSchema.parse(await dataOf(response))).toMatchObject(
      {
        provider: "pretium",
        providerOrderId: "TXDETAIL",
        depositAddress: SETTLEMENT,
        refundRequestedAt: requested.refundRequestedAt?.toISOString(),
        refundTxHash: refundHash,
      },
    );
  });
});

describe("resolving a Pretium payout as paid", () => {
  it("closes it once Pretium reports this transfer's transaction complete, recording the missing debit", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXPAID",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXPAID", transfer, "COMPLETE");

    // #when
    const confirmed = await resolve(payout, "paid");

    // #then
    expect(confirmed).toMatchObject({
      status: "paid",
      ledgerDebit: { usdcAmount: `-${transfer.amount}` },
    });
    expect(await readPayout(db, paying.company, payout.id)).toMatchObject({
      status: "paid",
      txHash: transfer.txHash,
    });
    expect(await ledgerTypes(payout.id)).toEqual(["payout"]);
    expect(await auditAfter(payout.id)).toMatchObject({
      resolution: "paid",
      paycrestStatus: null,
      pretium: {
        transaction: {
          state: "found",
          transactionCode: "TXPAID",
          status: "COMPLETE",
        },
      },
    });
    expect(paycrestReads).toEqual([]);
  });

  it("accepts Pretium's COMPLETED, found by the hash alone", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({ sent: true });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXHASHPAID", transfer, "COMPLETED");

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(201);
  });

  it.each(["PENDING", "PROCESSING", "FAILED", "REVERSED"])(
    "refuses while Pretium reports %s",
    async (status) => {
      // #given
      const { payout, transfer } = await pretiumPayout({
        sent: true,
        code: `TXNOTYET${status}`,
      });
      if (!transfer) throw new Error("no transfer");
      pretiumHas(`TXNOTYET${status}`, transfer, status);

      // #when
      const response = await prepare(payout, "paid");

      // #then
      expect(response.status).toBe(409);
      expect(await messageOf(response)).toBe(
        `Pretium reports transaction TXNOTYET${status} ${status}. A Pretium payout is marked paid only once Pretium reports it COMPLETE.`,
      );
    },
  );

  it("refuses when Pretium can't be read", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXUNREAD",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXUNREAD", transfer, "COMPLETE");
    pretium.state.failStatus = true;

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toMatch(
      /^Pretium couldn't be read \(.*\)\. Nothing was changed; try again shortly\.$/,
    );
  });

  it("refuses when Pretium has no transaction for the transfer", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({ sent: true });
    if (!transfer) throw new Error("no transfer");

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain(
      `Pretium has no transaction for ${transfer.txHash}`,
    );
  });

  it("refuses a complete transaction that is for another transfer", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXOTHER",
    });
    if (!transfer) throw new Error("no transfer");
    const other = { txHash: randomTxHash() };
    pretiumHas("TXOTHER", other, "COMPLETE");

    // #when
    const response = await prepare(payout, "paid");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain(
      "which isn't this payout's transfer",
    );
  });

  it("refuses when the payout's deposit address isn't Pretium's pinned settlement address", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXWRONGADDR",
      depositAddress: randomAddress().toLowerCase(),
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXWRONGADDR", transfer, "COMPLETE");

    // #when
    const [paid, failed] = [
      await prepare(payout, "paid"),
      await prepare(payout, "failed"),
    ];

    // #then
    expect([paid.status, failed.status]).toEqual([409, 409]);
    expect(await messageOf(paid)).toContain(
      "isn't Pretium's pinned settlement address",
    );
  });
});

describe("resolving a Pretium payout as failed", () => {
  it("closes it when nothing was sent", async () => {
    // #given
    const { payout } = await pretiumPayout({ sent: false });

    // #when
    const confirmed = await resolve(payout, "failed");

    // #then
    expect(confirmed.status).toBe("failed");
    expect(await ledgerTypes(payout.id)).toEqual([]);
    expect(paycrestReads).toEqual([]);
  });

  it("closes it once Pretium's refund of the whole transfer is back in the ledger", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXBACK",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXBACK", transfer, "REFUNDED");
    await refunded(payout, transfer.amount);

    // #when
    const confirmed = await resolve(payout, "failed");

    // #then
    expect(confirmed.status).toBe("failed");
    expect(await ledgerTypes(payout.id)).toEqual(["payout", "refund"]);
  });

  it("refuses while the USDC is with Pretium and no refund has come back", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXHELD",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXHELD", transfer, "FAILED");
    await refunded(payout, null);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain("no refund has come back");
  });

  it("refuses when the refund credited is less than was sent", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXSHORT",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXSHORT", transfer, "REFUNDED");
    await refunded(payout, transfer.amount - 1n);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain("less than the");
  });

  it("refuses when Pretium reports the recipient paid", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXWASPAID",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXWASPAID", transfer, "COMPLETE");
    await refunded(payout, transfer.amount);

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain(
      "the recipient is being or has been paid",
    );
  });

  it("refuses when Pretium can't be read about USDC that was sent", async () => {
    // #given
    const { payout, transfer } = await pretiumPayout({
      sent: true,
      code: "TXQUIET",
    });
    if (!transfer) throw new Error("no transfer");
    pretiumHas("TXQUIET", transfer, "REFUNDED");
    await refunded(payout, transfer.amount);
    pretium.state.failStatus = true;

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toMatch(/^Pretium couldn't be read/);
  });

  it("refuses while a transfer could still land", async () => {
    // #given
    const { payout } = await pretiumPayout({
      sent: false,
      fundedAgoMs: 10 * 60_000,
    });

    // #when
    const response = await prepare(payout, "failed");

    // #then
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain("a transfer could still land");
  });
});

describe("the Base hop of a Pretium payout", () => {
  const hop = "11111111-1111-4111-8111-111111111111";
  const base = {
    deliveryQuoteId: null,
    baseHopQuoteId: hop,
    orderRequestedAt: null,
  };

  it("holds the payout only until funding starts, since Pretium is told the hash after the send", () => {
    // #then
    expect([
      quoteHolding({ ...base, provider: "pretium", fundingStartedAt: null }),
      quoteHolding({
        ...base,
        provider: "pretium",
        fundingStartedAt: new Date(),
      }),
      quoteHolding({
        ...base,
        provider: "paycrest",
        fundingStartedAt: new Date(),
      }),
    ]).toEqual([hop, null, hop]);
  });

  it("is held by its Base hop for the quote's resolution exactly when quoteHolding says so", () => {
    // #given a Pretium cash-out under review, before and after funding starts
    const payouts = [null, new Date()].map((fundingStartedAt) => ({
      ...base,
      provider: "pretium" as const,
      status: "needs_review" as const,
      fundingStartedAt,
    }));

    // #then
    expect(
      payouts.map((payout) => ({
        quoteHolding: quoteHolding(payout) === hop,
        isHeldBy: isHeldBy({ purpose: "base_hop" }, payout),
      })),
    ).toEqual([
      { quoteHolding: true, isHeldBy: true },
      { quoteHolding: false, isHeldBy: false },
    ]);
  });
});
