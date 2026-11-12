import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewIntentQuote, NewPayout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import { randomNearAccount } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let wallet: TestWallet;

const baseHash = () => `0x${randomBytes(32).toString("hex")}`;
const baseAddress = () => `0x${randomBytes(20).toString("hex")}`;

/** An approved cash-out with nothing sent yet. */
function cashOut(overrides: Partial<NewPayout> = {}): NewPayout {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    subjectType: "claim",
    subjectId: randomUUID(),
    idempotencyKey: `claim:${randomUUID()}:1`,
    provider: "pretium",
    method: "mpesa_phone",
    recipient: {
      method: "mpesa_phone",
      phone: "+254712345678",
      accountName: "Jane Wanjiku",
    },
    requestedKesCents: 150_000n,
    amountKes: 150_000n,
    quotedRate: "128.68",
    quotedUsdc: 11_656_823n,
    maxDebitUsdc: 11_965_108n,
    status: "approved",
    approvalId: randomUUID(),
    approvedBy: company.admin.id,
    approvedAt: new Date(),
    ...overrides,
  };
}

/** The USDC is on its way to the provider's address. */
const sent = (overrides: Partial<NewPayout> = {}): Partial<NewPayout> => ({
  status: "funding",
  amountToTransferUsdc: 11_700_000n,
  depositAddress: baseAddress(),
  fundingStartedAt: new Date(),
  ...overrides,
});

async function insert(overrides: Partial<NewPayout> = {}) {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.insert(payouts).values(cashOut(overrides)).returning(),
  );
  if (!row) throw new Error("payout insert returned no row");
  return row;
}

async function baseHop() {
  const row: NewIntentQuote = {
    organizationId: company.organizationId,
    walletId: wallet.id,
    quoteKey: `hop:${randomUUID()}`,
    purpose: "base_hop",
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amountIn: 5_053_815n,
    minAmountIn: 5_003_276n,
    amountOut: 5_000_000n,
    depositAddress: randomNearAccount(),
    recipient: baseAddress(),
    refundTo: wallet.address,
    deadline: new Date("2026-11-11T12:00:00.000Z"),
    quoteResponse: { signature: "ed25519:test" },
  };
  const [quote] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.insert(intentQuotes).values(row).returning(),
  );
  if (!quote) throw new Error("quote insert returned no row");
  return quote;
}

interface Found {
  payout_id: string;
  organization_id: string;
}

/** Calls a lookup as the API's role, outside any company's scope. */
async function lookup(call: ReturnType<typeof sql>): Promise<Found[]> {
  const result = await db.execute<{
    payout_id: string;
    organization_id: string;
  }>(call);
  return result.rows.map(({ payout_id, organization_id }) => ({
    payout_id,
    organization_id,
  }));
}

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  company = await createCompany(db);
  wallet = await createActiveNearWallet(db, company, {
    privyWalletId: `near-wallet-${randomUUID()}`,
    accountId: randomNearAccount(),
  });
});

afterAll(async () => {
  await runtime.dispose();
});

describe("a Pretium cash-out", () => {
  it.each(["funding", "paying"] as const)(
    "can be %s before Pretium gives it a transaction code",
    async (status) => {
      // #when
      const row = await insert(sent({ status }));

      // #then
      expect(row).toMatchObject({ status, providerOrderId: null });
    },
  );

  it("still can't send until it knows how much and where", async () => {
    // #when
    const insertion = insert(sent({ depositAddress: null }));

    // #then
    await expect(insertion).rejects.toMatchObject({
      cause: { constraint: "payouts_funding_is_complete" },
    });
  });

  it("is whole shillings", async () => {
    // #when
    const insertion = insert({
      requestedKesCents: 150_050n,
      amountKes: 150_050n,
    });

    // #then
    await expect(insertion).rejects.toMatchObject({
      cause: { constraint: "payouts_whole_shillings" },
    });
  });

  it("can be funded by a Base hop", async () => {
    // #given
    const quote = await baseHop();

    // #when
    const row = await insert({ baseHopQuoteId: quote.id });

    // #then
    expect(row.baseHopQuoteId).toBe(quote.id);
  });

  it("records the refund Pretium sent back", async () => {
    // #given
    const refundTxHash = baseHash();
    const refundRequestedAt = new Date();

    // #when
    const row = await insert(
      sent({ status: "paying", refundRequestedAt, refundTxHash }),
    );

    // #then
    expect(row).toMatchObject({ refundRequestedAt, refundTxHash });
  });

  it("keeps a refund hash lowercase and 32 bytes long", async () => {
    // #when
    const insertions = [
      insert(
        sent({ refundTxHash: baseHash().toUpperCase().replace("0X", "0x") }),
      ),
      insert(sent({ refundTxHash: "0x1234" })),
    ];

    // #then
    for (const insertion of insertions) {
      await expect(insertion).rejects.toMatchObject({
        cause: { constraint: "payouts_refund_tx_hash_is_bytes32" },
      });
    }
  });

  it("gives a refund hash to one payout only", async () => {
    // #given
    const refundTxHash = baseHash();
    await insert(sent({ refundTxHash }));

    // #when
    const again = insert(sent({ refundTxHash }));

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "payouts_refund_tx_hash_unique" },
    });
  });
});

describe("a Paycrest cash-out", () => {
  it("can't be funding without an order", async () => {
    // #when
    const insertion = insert(sent({ provider: "paycrest" }));

    // #then
    await expect(insertion).rejects.toMatchObject({
      cause: { constraint: "payouts_funding_is_complete" },
    });
  });

  it.each([
    ["a refund request", { refundRequestedAt: new Date() }],
    ["a refund hash", { refundTxHash: baseHash() }],
  ])("can't hold %s", async (_label, refund) => {
    // #when
    const insertion = insert(
      sent({ provider: "paycrest", providerOrderId: randomUUID(), ...refund }),
    );

    // #then
    await expect(insertion).rejects.toMatchObject({
      cause: { constraint: "payouts_refund_is_pretium" },
    });
  });
});

describe("a USDC payout", () => {
  it("still can't be funded by a Base hop", async () => {
    // #given
    const quote = await baseHop();

    // #when
    const insertion = insert({
      subjectType: "bill",
      provider: "onchain",
      method: "usdc",
      recipient: {
        method: "usdc",
        chain: "solana",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        accountName: "Acme Ltd",
      },
      baseHopQuoteId: quote.id,
    });

    // #then
    await expect(insertion).rejects.toMatchObject({
      cause: { constraint: "payouts_base_hop_is_for_a_cash_out" },
    });
  });
});

describe("a provider's order ID", () => {
  it("can be the same at two providers", async () => {
    // #given
    const providerOrderId = randomUUID();
    await insert(sent({ provider: "paycrest", providerOrderId }));

    // #when
    const row = await insert(sent({ provider: "pretium", providerOrderId }));

    // #then
    expect(row.providerOrderId).toBe(providerOrderId);
  });

  it.each(["paycrest", "pretium"] as const)(
    "names one payout only at %s",
    async (provider) => {
      // #given
      const providerOrderId = randomUUID();
      await insert(sent({ provider, providerOrderId }));

      // #when
      const again = insert(sent({ provider, providerOrderId }));

      // #then
      await expect(again).rejects.toMatchObject({
        cause: { constraint: "payouts_provider_order_id_unique" },
      });
    },
  );
});

describe("Pretium lookups, for work that starts without a company", () => {
  it("finds a cash-out by its Pretium transaction code only", async () => {
    // #given
    const code = `TX${randomBytes(6).toString("hex")}`;
    const pretium = await insert(
      sent({ status: "paying", providerOrderId: code }),
    );
    const paycrestCode = randomUUID();
    await insert(sent({ provider: "paycrest", providerOrderId: paycrestCode }));

    // #when
    const found = await lookup(
      sql`SELECT * FROM payout_by_pretium_transaction(${code})`,
    );
    const notPretium = await lookup(
      sql`SELECT * FROM payout_by_pretium_transaction(${paycrestCode})`,
    );

    // #then
    expect(found).toEqual([
      { payout_id: pretium.id, organization_id: company.organizationId },
    ]);
    expect(notPretium).toEqual([]);
  });

  it("finds a cash-out by the hash of the USDC it sent to Pretium, in any case", async () => {
    // #given
    const txHash = baseHash();
    const pretium = await insert(sent({ status: "paying", txHash }));
    const paycrestHash = baseHash();
    await insert(
      sent({
        provider: "paycrest",
        providerOrderId: randomUUID(),
        status: "paying",
        txHash: paycrestHash,
      }),
    );

    // #when
    const found = await lookup(
      sql`SELECT * FROM payout_by_pretium_hash(${txHash.toUpperCase().replace("0X", "0x")})`,
    );
    const notPretium = await lookup(
      sql`SELECT * FROM payout_by_pretium_hash(${paycrestHash})`,
    );

    // #then
    expect(found).toEqual([
      { payout_id: pretium.id, organization_id: company.organizationId },
    ]);
    expect(notPretium).toEqual([]);
  });

  it("finds a cash-out by the hash of its refund, in any case", async () => {
    // #given
    const refundTxHash = baseHash();
    const txHash = baseHash();
    const refunded = await insert(
      sent({
        status: "paying",
        txHash,
        refundRequestedAt: new Date(),
        refundTxHash,
      }),
    );

    // #when
    const found = await lookup(
      sql`SELECT * FROM payout_by_refund_tx_hash(${refundTxHash.toUpperCase().replace("0X", "0x")})`,
    );
    const bySendHash = await lookup(
      sql`SELECT * FROM payout_by_refund_tx_hash(${txHash})`,
    );

    // #then
    expect(found).toEqual([
      { payout_id: refunded.id, organization_id: company.organizationId },
    ]);
    expect(bySendHash).toEqual([]);
  });

  it("reconciles Pretium cash-outs that have USDC in flight, and nothing else", async () => {
    // #given
    const funding = await insert(sent());
    const paying = await insert(sent({ status: "paying", txHash: baseHash() }));
    const approved = await insert();
    const needsReview = await insert(sent({ status: "needs_review" }));
    const paycrest = await insert(
      sent({ provider: "paycrest", providerOrderId: randomUUID() }),
    );

    // #when
    const due = await lookup(
      sql`SELECT * FROM pretium_payouts_to_reconcile(${100_000})`,
    );
    const paycrestDue = await lookup(
      sql`SELECT * FROM paycrest_payouts_to_reconcile(${100_000})`,
    );

    // #then
    const dueIds = due.map(({ payout_id }) => payout_id);
    expect(dueIds).toEqual(expect.arrayContaining([funding.id, paying.id]));
    expect(dueIds).not.toContain(approved.id);
    expect(dueIds).not.toContain(needsReview.id);
    expect(dueIds).not.toContain(paycrest.id);
    expect(paycrestDue.map(({ payout_id }) => payout_id)).not.toContain(
      funding.id,
    );
  });

  it("finds approved Pretium cash-outs awaiting funding, and nothing else", async () => {
    // #given
    const approved = await insert();
    const funding = await insert(sent());
    const failed = await insert({ status: "failed" });
    const paycrest = await insert({ provider: "paycrest" });

    // #when
    const due = await lookup(
      sql`SELECT * FROM pretium_cash_outs_awaiting_funding(${100_000})`,
    );

    // #then
    const dueIds = due.map(({ payout_id }) => payout_id);
    expect(dueIds).toContain(approved.id);
    expect(dueIds).not.toContain(funding.id);
    expect(dueIds).not.toContain(failed.id);
    expect(dueIds).not.toContain(paycrest.id);
  });

  it("is limited to the rows asked for", async () => {
    // #given
    await insert(sent());
    await insert(sent());

    // #when
    const due = await lookup(
      sql`SELECT * FROM pretium_payouts_to_reconcile(1)`,
    );

    // #then
    expect(due).toHaveLength(1);
  });
});
