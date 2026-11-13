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

describe("wallet_transactions, for a delivery into a confidential account", () => {
  async function deliveredQuote() {
    const { company, wallet } = await companyWithWallet();
    const [quote] = await insertQuote(
      company,
      treasuryQuote(company, wallet, {
        quoteKey: `fund_in:${randomUUID()}`,
        purpose: "fund_in",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        recipient: wallet.address,
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "INTENTS",
        status: "succeeded",
        settledAt: new Date(),
      }),
    );
    if (!quote) throw new Error("quote insert returned no row");
    return { company, wallet, quote };
  }

  /** A deposit that records a quote's delivery: no chain transaction at all. */
  const settlement = (
    company: TestCompany,
    wallet: TestWallet,
    quoteId: string,
    overrides: Partial<NewWalletTransaction> = {},
  ) =>
    ledgerRow(company, wallet, {
      type: "deposit",
      chain: "near",
      intentQuoteId: quoteId,
      ...overrides,
    });

  it("records the delivery of a quote with no chain transaction", async () => {
    // #given
    const { company, wallet, quote } = await deliveredQuote();

    // #when
    const insert = insertLedger(company, settlement(company, wallet, quote.id));

    // #then
    await expect(insert).resolves.toBeDefined();
  });

  it("credits a quote once", async () => {
    // #given
    const { company, wallet, quote } = await deliveredQuote();
    await insertLedger(company, settlement(company, wallet, quote.id));

    // #when
    const again = insertLedger(
      company,
      settlement(company, wallet, quote.id, { usdcAmount: 2_000_000n }),
    );

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_quote_settled_credit_unique" },
    });
  });

  it("credits two quotes of one company, one each", async () => {
    // #given
    const { company, wallet, quote } = await deliveredQuote();
    const [other] = await insertQuote(
      company,
      treasuryQuote(company, wallet, {
        quoteKey: `fund_in:${randomUUID()}`,
        purpose: "fund_in",
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "INTENTS",
      }),
    );
    if (!other) throw new Error("quote insert returned no row");
    await insertLedger(company, settlement(company, wallet, quote.id));

    // #when
    const second = insertLedger(company, settlement(company, wallet, other.id));

    // #then
    await expect(second).resolves.toBeDefined();
  });

  it.each([
    ["on Base", { chain: "base" as const }],
    ["with a transaction hash", { txHash: randomNearTxHash() }],
    ["with a block", { blockNumber: 10n }],
    ["with a log position", { logIndex: 0 }],
  ])("rejects a delivery recorded %s", async (_name, overrides) => {
    // #given
    const { company, wallet, quote } = await deliveredQuote();

    // #when
    const insert = insertLedger(
      company,
      settlement(company, wallet, quote.id, overrides),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_deposit_has_source" },
    });
  });

  it("rejects an on-chain deposit that also names a quote", async () => {
    // #given
    const { company, wallet, quote } = await deliveredQuote();

    // #when
    const insert = insertLedger(
      company,
      settlement(company, wallet, quote.id, {
        txHash: randomNearTxHash(),
        receiptId: randomNearTxHash(),
        logIndex: 0,
        transferIndex: 0,
        blockNumber: 10n,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_deposit_has_source" },
    });
  });

  it("rejects a deposit with neither a chain transaction nor a quote", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, { type: "deposit", chain: "near" }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_deposit_has_source" },
    });
  });

  it("rejects a NEAR deposit with a transaction but no receipt and no quote", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "deposit",
        chain: "near",
        txHash: randomNearTxHash(),
        logIndex: 0,
        blockNumber: 10n,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_near_deposit_has_receipt" },
    });
  });

  it("still records an ordinary NEAR deposit with its receipt", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "deposit",
        chain: "near",
        txHash: randomNearTxHash(),
        receiptId: randomNearTxHash(),
        logIndex: 0,
        transferIndex: 0,
        blockNumber: 10n,
      }),
    );

    // #then
    await expect(insert).resolves.toBeDefined();
  });

  it("still records an ordinary deposit on Base", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "deposit",
        chain: "base",
        txHash: `0x${randomBytes(32).toString("hex")}`,
        logIndex: 0,
        blockNumber: 10n,
      }),
    );

    // #then
    await expect(insert).resolves.toBeDefined();
  });

  it("still names a quote on a Treasury row, and credits one from Treasury in several transfers", async () => {
    // #given the Treasury quote the move paid, and a credit that names it
    const { company, wallet, move: saved, quote } = await toTreasuryContext();
    const treasuryRow = (
      type: "to_treasury" | "from_treasury",
      amount: bigint,
    ) =>
      insertLedger(
        company,
        ledgerRow(company, wallet, {
          type,
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

    // #then
    await expect(
      treasuryRow("to_treasury", -5_000_000n),
    ).resolves.toBeDefined();
    await expect(
      treasuryRow("from_treasury", 3_000_000n),
    ).resolves.toBeDefined();
    await expect(
      treasuryRow("from_treasury", 2_000_000n),
    ).resolves.toBeDefined();
  });

  async function toTreasuryContext() {
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);
    const quote = await savedQuote(company, wallet, saved.id);
    return { company, wallet, move: saved, quote };
  }

  it.each(["refund", "topup"] as const)(
    "still rejects a %s that names a quote",
    async (type) => {
      // #given
      const { company, wallet, quote } = await deliveredQuote();

      // #when
      const insert = insertLedger(
        company,
        ledgerRow(company, wallet, { type, intentQuoteId: quote.id }),
      );

      // #then
      await expect(insert).rejects.toMatchObject({
        cause: { constraint: "wallet_transactions_quote_link_is_treasury" },
      });
    },
  );
});

describe("wallet_transactions, for a Treasury part paid from a confidential account", () => {
  async function paidFromAccount() {
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet);
    const quote = await savedQuote(company, wallet, saved.id, {
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
      status: "refunded",
      settledAt: new Date(),
    });
    return { company, wallet, move: saved, quote };
  }

  const debit = (
    company: TestCompany,
    wallet: TestWallet,
    moveId: string,
    quoteId: string,
    amount = -5_000_000n,
  ) =>
    insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "to_treasury",
        chain: "near",
        usdcAmount: amount,
        treasuryMoveId: moveId,
        intentQuoteId: quoteId,
      }),
    );

  const refundCredit = (
    company: TestCompany,
    wallet: TestWallet,
    moveId: string,
    quoteId: string,
    amount = 5_000_000n,
  ) =>
    insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "from_treasury",
        chain: "near",
        usdcAmount: amount,
        treasuryMoveId: moveId,
        intentQuoteId: quoteId,
      }),
    );

  it("records the debit with no chain transaction", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await paidFromAccount();

    // #when
    const insert = debit(company, wallet, saved.id, quote.id);

    // #then
    await expect(insert).resolves.toBeDefined();
  });

  it("debits a quote once", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await paidFromAccount();
    await debit(company, wallet, saved.id, quote.id);

    // #when
    const again = debit(company, wallet, saved.id, quote.id, -4_000_000n);

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_to_treasury_quote_unique" },
    });
  });

  it("records a refunded part's debit and its credit, both naming the quote", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await paidFromAccount();
    await debit(company, wallet, saved.id, quote.id);

    // #when
    const credit = refundCredit(company, wallet, saved.id, quote.id);

    // #then
    await expect(credit).resolves.toBeDefined();
  });

  it("credits a refunded part once", async () => {
    // #given
    const { company, wallet, move: saved, quote } = await paidFromAccount();
    await debit(company, wallet, saved.id, quote.id);
    await refundCredit(company, wallet, saved.id, quote.id);

    // #when
    const again = refundCredit(company, wallet, saved.id, quote.id, 1_000_000n);

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_quote_settled_credit_unique" },
    });
  });

  it("records the settlement credit of a return delivered into the account, once", async () => {
    // #given a Move to wallet quote 1Click delivered to the confidential account
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet, {
      direction: "to_wallet",
    });
    const quote = await savedQuote(company, wallet, saved.id, {
      quoteKey: `from_treasury:${randomUUID()}`,
      purpose: "from_treasury",
      originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
      destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
      recipient: wallet.address,
      recipientType: "CONFIDENTIAL_INTENTS",
      refundTo: baseAddress(),
      status: "succeeded",
      settledAt: new Date(),
    });

    // #when
    const credit = refundCredit(company, wallet, saved.id, quote.id);
    const again = refundCredit(company, wallet, saved.id, quote.id);

    // #then
    await expect(credit).resolves.toBeDefined();
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_quote_settled_credit_unique" },
    });
  });

  it("rejects a credit with no move", async () => {
    // #given
    const { company, wallet, quote } = await paidFromAccount();

    // #when
    const insert = insertLedger(
      company,
      ledgerRow(company, wallet, {
        type: "from_treasury",
        chain: "near",
        intentQuoteId: quote.id,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_treasury_has_move" },
    });
  });
});

describe("intent_quotes, for Treasury and a confidential account", () => {
  async function moveContext(direction: "to_treasury" | "to_wallet") {
    const { company, wallet } = await companyWithWallet();
    const saved = await savedMove(company, wallet, { direction });
    return { company, wallet, move: saved };
  }

  const returnQuote = (
    wallet: TestWallet,
    overrides: Partial<NewIntentQuote> = {},
  ): Partial<NewIntentQuote> => ({
    quoteKey: `from_treasury:${randomUUID()}`,
    purpose: "from_treasury",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    recipient: wallet.address,
    refundTo: baseAddress(),
    ...overrides,
  });

  it("saves a part paid from and refunding into a confidential account", async () => {
    // #given
    const { company, wallet, move: saved } = await moveContext("to_treasury");

    // #when
    const insert = savedQuote(company, wallet, saved.id, {
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
    });

    // #then
    await expect(insert).resolves.toMatchObject({
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
    });
  });

  it.each([
    [
      "a confidential deposit refunding on the origin chain",
      {
        depositType: "CONFIDENTIAL_INTENTS" as const,
      },
    ],
    [
      "a confidential refund for a deposit on the origin chain",
      {
        refundType: "CONFIDENTIAL_INTENTS" as const,
      },
    ],
  ])("rejects %s", async (_name, overrides) => {
    // #given
    const { company, wallet, move: saved } = await moveContext("to_treasury");

    // #when
    const insert = savedQuote(company, wallet, saved.id, overrides);

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_intents_side_matches_purpose" },
    });
  });

  it("saves a return delivering into a confidential account, and lets it be marked credited once settled", async () => {
    // #given
    const { company, wallet, move: saved } = await moveContext("to_wallet");

    // #when
    const quote = await savedQuote(
      company,
      wallet,
      saved.id,
      returnQuote(wallet, {
        recipientType: "CONFIDENTIAL_INTENTS",
        status: "succeeded",
        settledAt: new Date(),
        ledgerCreditedAt: new Date(),
      }),
    );

    // #then
    expect(quote.ledgerCreditedAt).not.toBeNull();
  });

  it("rejects a return delivered to a chain address being marked credited", async () => {
    // #given
    const { company, wallet, move: saved } = await moveContext("to_wallet");

    // #when
    const insert = savedQuote(
      company,
      wallet,
      saved.id,
      returnQuote(wallet, {
        status: "succeeded",
        settledAt: new Date(),
        ledgerCreditedAt: new Date(),
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: {
        constraint: "intent_quotes_ledger_credit_is_confidential_delivery",
      },
    });
  });

  it("rejects a part paid from a confidential account being marked credited", async () => {
    // #given
    const { company, wallet, move: saved } = await moveContext("to_treasury");

    // #when
    const insert = savedQuote(company, wallet, saved.id, {
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
      status: "succeeded",
      settledAt: new Date(),
      ledgerCreditedAt: new Date(),
    });

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: {
        constraint: "intent_quotes_ledger_credit_is_confidential_delivery",
      },
    });
  });
});
