import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type {
  NewIntentQuote,
  NewTreasuryMove,
  NewWalletTransaction,
} from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  treasuryMoves,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { randomNearAccount, randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;
let walletA: TestWallet;
let walletB: TestWallet;

const nearWallet = () => ({
  privyWalletId: `near-wallet-${randomUUID()}`,
  accountId: randomNearAccount(),
});

const baseAddress = () => `0x${randomBytes(20).toString("hex")}`;

function move(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewTreasuryMove> = {},
): NewTreasuryMove {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    direction: "to_treasury",
    requestedUsdc: 5_000_000n,
    confirmedBy: company.admin.id,
    approvalId: randomUUID(),
    ...overrides,
  };
}

const insertMove = (company: TestCompany, row: NewTreasuryMove) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(treasuryMoves).values(row).returning(),
  );

async function savedMove(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewTreasuryMove> = {},
) {
  const [saved] = await insertMove(company, move(company, wallet, overrides));
  if (!saved) throw new Error("move insert returned no row");
  return saved;
}

function treasuryQuote(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
): NewIntentQuote {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    quoteKey: `to_treasury:${randomUUID()}`,
    purpose: "to_treasury",
    swapType: "EXACT_INPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amountIn: 5_000_000n,
    amountOut: 4_995_000n,
    minAmountOut: 4_950_000n,
    depositAddress: randomNearAccount(),
    recipient: baseAddress(),
    refundTo: wallet.address,
    deadline: new Date("2026-11-11T12:00:00.000Z"),
    quoteResponse: { signature: "ed25519:test" },
    ...overrides,
  };
}

const insertQuote = (company: TestCompany, row: NewIntentQuote) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(intentQuotes).values(row).returning(),
  );

async function savedQuote(
  company: TestCompany,
  wallet: TestWallet,
  treasuryMoveId: string,
  overrides: Partial<NewIntentQuote> = {},
) {
  const [quote] = await insertQuote(
    company,
    treasuryQuote(company, wallet, { treasuryMoveId, ...overrides }),
  );
  if (!quote) throw new Error("quote insert returned no row");
  return quote;
}

const insertLedger = (company: TestCompany, row: NewWalletTransaction) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(walletTransactions).values(row),
  );

function ledgerRow(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewWalletTransaction>,
): NewWalletTransaction {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    type: "topup",
    usdcAmount: 1_000_000n,
    ...overrides,
  };
}

async function companyWithWallet() {
  const company = await createCompany(db);
  return {
    company,
    wallet: await createActiveNearWallet(db, company, nearWallet()),
  };
}

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
  [walletA, walletB] = await Promise.all([
    createActiveNearWallet(db, fixture.companyA, nearWallet()),
    createActiveNearWallet(db, fixture.companyB, nearWallet()),
  ]);
  await savedMove(fixture.companyA, walletA);
  await savedMove(fixture.companyB, walletB);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("treasury_moves", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "treasury_moves");
  });

  it("starts a move as open, with nothing settled", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const saved = await savedMove(company, wallet);

    // #then
    expect(saved).toMatchObject({
      status: "open",
      isAll: false,
      movedUsdc: null,
      costUsdc: null,
      settledAt: null,
    });
  });

  it("can't record a move against another company's wallet", async () => {
    // #when
    const crossed = insertMove(
      fixture.companyA,
      move(fixture.companyA, walletB, {
        status: "failed",
        settledAt: new Date(),
      }),
    );

    // #then
    await expect(crossed).rejects.toMatchObject({
      cause: { constraint: "treasury_moves_wallet_organization_fk" },
    });
  });

  it.each([["open" as const], ["needs_review" as const]])(
    "allows one %s move per company at a time",
    async (status) => {
      // #given
      const { company, wallet } = await companyWithWallet();
      await savedMove(company, wallet, { status });

      // #when
      const second = insertMove(company, move(company, wallet));

      // #then
      await expect(second).rejects.toMatchObject({
        cause: { constraint: "treasury_moves_one_unsettled_per_company" },
      });
    },
  );

  it("allows a new move once the last has settled, and keeps every settled one", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const settledAt = new Date();
    await savedMove(company, wallet, { status: "completed", settledAt });
    await savedMove(company, wallet, { status: "failed", settledAt });

    // #when
    const next = await savedMove(company, wallet);

    // #then
    expect(next.status).toBe("open");
  });

  it.each([
    ["a requested amount of zero", { requestedUsdc: 0n }, "requested_positive"],
    [
      "all of the wallet's USDC to Treasury",
      { isAll: true },
      "all_is_to_wallet",
    ],
    [
      "a final status without a time",
      { status: "completed" as const },
      "settled_has_time",
    ],
    ["a time while still open", { settledAt: new Date() }, "settled_has_time"],
  ])("rejects %s", async (_name, overrides, constraint) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertMove(company, move(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: `treasury_moves_${constraint}` },
    });
  });

  it("accepts all of the vault on a move to the wallet", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const saved = await savedMove(company, wallet, {
      direction: "to_wallet",
      isAll: true,
    });

    // #then
    expect(saved.isAll).toBe(true);
  });

  it("can't be deleted by the app role", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    await savedMove(company, wallet);

    // #when
    const remove = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.delete(treasuryMoves),
    );

    // #then
    await expect(remove).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("can't change what was asked once saved, only settle it", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);

    // #when
    const change = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .update(treasuryMoves)
          .set({ requestedUsdc: 1n })
          .where(eq(treasuryMoves.id, saved.id)),
    );

    // #then
    await expect(change).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("intent_quotes, for Treasury", () => {
  it("links a to_treasury quote to its move, and lets the company wallet pay it", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);

    // #when
    const quote = await savedQuote(company, wallet, saved.id);

    // #then
    expect(quote).toMatchObject({
      purpose: "to_treasury",
      treasuryMoveId: saved.id,
    });
  });

  it.each([["to_treasury" as const], ["from_treasury" as const]])(
    "rejects a %s quote with no move",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const insert = insertQuote(
        company,
        treasuryQuote(company, wallet, { purpose }),
      );

      // #then
      await expect(insert).rejects.toMatchObject({
        cause: { constraint: "intent_quotes_treasury_move_matches_purpose" },
      });
    },
  );

  it("rejects a quote for anything else that names a move", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);

    // #when
    const insert = insertQuote(
      company,
      treasuryQuote(company, wallet, {
        purpose: "base_hop",
        treasuryMoveId: saved.id,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_treasury_move_matches_purpose" },
    });
  });

  it("can't name another company's move", async () => {
    // #given
    const other = await savedMove(fixture.companyB, walletB, {
      status: "completed",
      settledAt: new Date(),
    });

    // #when
    const insert = insertQuote(
      fixture.companyA,
      treasuryQuote(fixture.companyA, walletA, { treasuryMoveId: other.id }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_treasury_move_organization_fk" },
    });
  });
});

describe("wallet_transactions, for Treasury", () => {
  async function toTreasuryContext() {
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);
    const quote = await savedQuote(company, wallet, saved.id);
    return { company, wallet, move: saved, quote };
  }

  it("records a debit to Treasury and a credit back from it", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await toTreasuryContext();

    // #when
    await insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "to_treasury",
        usdcAmount: -5_000_000n,
        treasuryMoveId: saved.id,
        intentQuoteId: quote.id,
      }),
    );
    const credit = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "from_treasury",
        usdcAmount: 5_000_000n,
        treasuryMoveId: saved.id,
      }),
    );

    // #then
    await expect(credit).resolves.toBeDefined();
  });

  it.each([
    [
      "a to_treasury credit",
      { type: "to_treasury" as const, usdcAmount: 1n },
      "wallet_transactions_amount_sign",
    ],
    [
      "a from_treasury debit",
      { type: "from_treasury" as const, usdcAmount: -1n },
      "wallet_transactions_amount_sign",
    ],
    [
      "a zero from_treasury",
      { type: "from_treasury" as const, usdcAmount: 0n },
      "wallet_transactions_amount_sign",
    ],
  ])("rejects %s", async (_name, overrides, constraint) => {
    // #given
    const { company, wallet, move: saved, quote } = await toTreasuryContext();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        treasuryMoveId: saved.id,
        intentQuoteId: overrides.type === "to_treasury" ? quote.id : null,
        ...overrides,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({ cause: { constraint } });
  });

  it.each([
    ["to_treasury" as const, -1_000_000n],
    ["from_treasury" as const, 1_000_000n],
  ])("rejects a %s row with no move", async (type, usdcAmount) => {
    // #given
    const { company, wallet, quote } = await toTreasuryContext();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type,
        usdcAmount,
        intentQuoteId: type === "to_treasury" ? quote.id : null,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_treasury_has_move" },
    });
  });

  it("rejects a top-up that names a move", async () => {
    // #given
    const { company, wallet, move: saved } = await toTreasuryContext();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, { treasuryMoveId: saved.id }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_treasury_has_move" },
    });
  });

  it("rejects a debit to Treasury that names no quote", async () => {
    // #given
    const { company, wallet, move: saved } = await toTreasuryContext();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "to_treasury",
        usdcAmount: -1_000_000n,
        treasuryMoveId: saved.id,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_quote_link_is_treasury" },
    });
  });

  it("debits a quote's send once", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await toTreasuryContext();
    const debit = (txHash: string) =>
      insertLedger(
        company,
        ledgerRow(company, wallet, {
          type: "to_treasury",
          usdcAmount: -5_000_000n,
          treasuryMoveId: saved.id,
          intentQuoteId: quote.id,
          chain: "near",
          txHash,
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
        }),
      );
    await debit(randomNearTxHash());

    // #when
    const again = debit(randomNearTxHash());

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_to_treasury_quote_unique" },
    });
  });

  it("lets a from_treasury credit name the quote it delivered, in as many transfers as it came in", async () => {
    // #given a quote the credit may name
    const { company, wallet, move: saved, quote } = await toTreasuryContext();
    const credit = (amount: bigint) =>
      insertLedger(
        company,
        ledgerRow(company, wallet, {
          type: "from_treasury",
          usdcAmount: amount,
          treasuryMoveId: saved.id,
          intentQuoteId: quote.id,
          chain: "near",
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
        }),
      );

    // #then both transfers of one delivery are credited
    await expect(credit(3_000_000n)).resolves.toBeDefined();
    await expect(credit(2_000_000n)).resolves.toBeDefined();
  });

  it("still debits a quote once when a credit names it too", async () => {
    // #given a credit that names the quote
    const { company, wallet, move: saved, quote } = await toTreasuryContext();
    const row = (type: "to_treasury" | "from_treasury", usdcAmount: bigint) =>
      insertLedger(
        company,
        ledgerRow(company, wallet, {
          type,
          usdcAmount,
          treasuryMoveId: saved.id,
          intentQuoteId: quote.id,
          chain: "near",
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
        }),
      );
    await row("from_treasury", 1_000_000n);

    // #when it is debited, and then debited again
    await expect(row("to_treasury", -5_000_000n)).resolves.toBeDefined();
    const again = row("to_treasury", -5_000_000n);

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_to_treasury_quote_unique" },
    });
  });

  it("rejects a top-up that names a quote", async () => {
    // #given
    const { company, wallet, quote } = await toTreasuryContext();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, { intentQuoteId: quote.id }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_quote_link_is_treasury" },
    });
  });

  it("can't name another company's move", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const other = await savedMove(fixture.companyA, walletA, {
      status: "completed",
      settledAt: new Date(),
    });

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "from_treasury",
        treasuryMoveId: other.id,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: {
        constraint: "wallet_transactions_treasury_move_organization_fk",
      },
    });
  });
});
