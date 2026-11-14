import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type {
  IntentQuotePurpose,
  NewIntentQuote,
} from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  intentQuotes,
  wallets,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
} from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import { createCustomerAndInvoice } from "../helpers/invoices.js";
import { saveTreasuryMove } from "../helpers/money-in.js";
import { randomNearAccount, randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

function quote(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
): NewIntentQuote {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    quoteKey: `quote:${randomUUID()}`,
    purpose: "usdc_payout",
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amountIn: 5_053_815n,
    minAmountIn: 5_003_276n,
    amountOut: 5_000_000n,
    depositAddress: randomNearAccount(),
    recipient: randomNearAccount(),
    refundTo: wallet.address,
    deadline: new Date("2026-11-11T12:00:00.000Z"),
    quoteResponse: { signature: "ed25519:test" },
    ...overrides,
  };
}

const insertAs = (company: TestCompany, row: NewIntentQuote) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(intentQuotes).values(row).returning(),
  );

async function companyWithWallet() {
  const company = await createCompany(db);
  const wallet = await createActiveNearWallet(db, company, {
    privyWalletId: `near-wallet-${randomUUID()}`,
    accountId: randomNearAccount(),
  });
  return { company, wallet };
}

const signedIntent = { standard: "nep413", payload: { message: "{}" } };
const deadline = new Date("2026-11-11T12:00:00.000Z");

/**
 * A payout paid out of a confidential account, whose deposit has started.
 * Refunded, so a job that walks every company never picks it up.
 */
const paidFromAccount = {
  depositType: "CONFIDENTIAL_INTENTS",
  refundType: "CONFIDENTIAL_INTENTS",
  status: "refunded",
  settledAt: deadline,
  depositStartedAt: deadline,
} as const;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("a wallet's balance home", () => {
  it("is the company wallet unless told otherwise", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ balanceHome: wallets.balanceHome })
          .from(wallets)
          .where(eq(wallets.id, wallet.id)),
    );

    // #then
    expect(row?.balanceHome).toBe("company_wallet");
  });
});

describe("a quote's recipient type", () => {
  it("is the destination chain unless told otherwise", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(company, quote(company, wallet));

    // #then
    expect(row?.recipientType).toBe("DESTINATION_CHAIN");
  });

  it("accepts a move into a confidential account", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(
      company,
      quote(company, wallet, {
        purpose: "move_in",
        swapType: "EXACT_INPUT",
        recipientType: "CONFIDENTIAL_INTENTS",
      }),
    );

    // #then
    expect(row).toMatchObject({
      purpose: "move_in",
      recipientType: "CONFIDENTIAL_INTENTS",
      signedIntent: null,
      intentHash: null,
      intentDeadline: null,
      intentSubmittedAt: null,
    });
  });
});

describe("a quote's signed intent", () => {
  it("saves the message with its deadline, hash and submission time", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(
      company,
      quote(company, wallet, {
        ...paidFromAccount,
        signedIntent,
        intentDeadline: deadline,
        intentHash: "hash-from-1click",
        intentSubmittedAt: deadline,
      }),
    );

    // #then
    expect(row).toMatchObject({
      signedIntent,
      intentDeadline: deadline,
      intentHash: "hash-from-1click",
    });
  });

  it("accepts a signed intent not yet submitted", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      quote(company, wallet, {
        ...paidFromAccount,
        signedIntent,
        intentDeadline: deadline,
      }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it.each([
    ["a signed intent without a deadline", { signedIntent }],
    ["a deadline without a signed intent", { intentDeadline: deadline }],
  ])("rejects %s", async (_name, overrides) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      quote(company, wallet, { ...paidFromAccount, ...overrides }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_signed_intent_has_deadline" },
    });
  });

  it.each([
    ["a hash", { intentHash: "hash-from-1click" }],
    ["a submission time", { intentSubmittedAt: deadline }],
  ])("rejects %s without a signed intent", async (_name, overrides) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, quote(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_intent_submitted_is_signed" },
    });
  });
});

/** The columns a quote of this purpose needs to be a valid row, apart from its recipient type. */
async function quoteOf(
  purpose: Exclude<IntentQuotePurpose, "move_out">,
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
): Promise<NewIntentQuote> {
  const base = quote(company, wallet, { purpose });
  switch (purpose) {
    case "move_in":
    case "fee_cover":
      return { ...base, swapType: "EXACT_INPUT", ...overrides };
    case "fund_in":
      return {
        ...base,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.base,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        refundType: "INTENTS",
        ...overrides,
      };
    case "fund_in_return":
      return {
        ...base,
        swapType: "EXACT_INPUT",
        depositType: "INTENTS",
        refundType: "INTENTS",
        ...overrides,
      };
    case "invoice_payment": {
      const invoice = await createCustomerAndInvoice(db, company, {
        status: "open",
      });
      return {
        ...base,
        swapType: "EXACT_INPUT",
        invoiceId: invoice.invoiceId,
        refundType: "INTENTS",
        ...overrides,
      };
    }
    case "to_treasury":
    case "from_treasury": {
      const treasuryMove = await saveTreasuryMove(
        db,
        { company, walletId: wallet.id },
        { direction: purpose === "to_treasury" ? "to_treasury" : "to_wallet" },
      );
      return {
        ...base,
        swapType: "EXACT_INPUT",
        treasuryMoveId: treasuryMove.id,
        ...overrides,
      };
    }
    case "sweep":
      return { ...base, swapType: "EXACT_INPUT", ...overrides };
    case "base_hop":
    case "usdc_payout":
      return { ...base, ...overrides };
  }
}

describe("a quote's recipient type, by purpose", () => {
  it.each([
    "fund_in",
    "invoice_payment",
    "fund_in_return",
    "sweep",
    "from_treasury",
    "fee_cover",
  ] as const)(
    "accepts a %s delivered to a confidential account",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const insert = insertAs(
        company,
        await quoteOf(purpose, company, wallet, {
          recipientType: "CONFIDENTIAL_INTENTS",
        }),
      );

      // #then
      await expect(insert).resolves.toHaveLength(1);
    },
  );

  it.each(["base_hop", "usdc_payout", "to_treasury"] as const)(
    "rejects a %s delivered to a confidential account",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const insert = insertAs(
        company,
        await quoteOf(purpose, company, wallet, {
          recipientType: "CONFIDENTIAL_INTENTS",
        }),
      );

      // #then
      await expect(insert).rejects.toMatchObject({
        cause: {
          constraint: "intent_quotes_recipient_type_matches_purpose",
        },
      });
    },
  );

  it.each(["move_in", "fee_cover"] as const)(
    "rejects a %s delivered to a destination chain",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const insert = insertAs(
        company,
        await quoteOf(purpose, company, wallet, {
          recipientType: "DESTINATION_CHAIN",
        }),
      );

      // #then
      await expect(insert).rejects.toMatchObject({
        cause: { constraint: "intent_quotes_recipient_type_matches_purpose" },
      });
    },
  );

  it.each([
    "base_hop",
    "usdc_payout",
    "fund_in",
    "invoice_payment",
    "fund_in_return",
  ] as const)(
    "still accepts a %s delivered to its destination chain",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const insert = insertAs(company, await quoteOf(purpose, company, wallet));

      // #then
      await expect(insert).resolves.toHaveLength(1);
    },
  );
});

describe("a move-in's send", () => {
  async function executedSend(company: TestCompany, wallet: TestWallet) {
    const [send] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .insert(companyWalletSends)
          .values({
            organizationId: company.organizationId,
            walletId: wallet.id,
            sendKey: `move-in-${randomUUID()}`,
            kind: "transfer",
            status: "executed",
            senderAccountId: wallet.address,
            receiverAccountId: randomNearAccount(),
            usdcAmount: 5_053_815n,
            nonce: 2n,
            maxBlockHeight: 1_000n,
            signedDelegate: "c2lnbmVk",
            txHash: randomNearTxHash(),
            blockHeight: 900n,
          })
          .returning(),
    );
    if (!send) throw new Error("send insert returned no row");
    return send;
  }

  it("is paid from the company wallet", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const send = await executedSend(company, wallet);

    // #when
    const insert = insertAs(
      company,
      await quoteOf("move_in", company, wallet, {
        recipientType: "CONFIDENTIAL_INTENTS",
        companyWalletSendId: send.id,
      }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });
});

describe("a quote's ledger credit time", () => {
  const credited = (
    purpose:
      | "fund_in"
      | "invoice_payment"
      | "fund_in_return"
      | "from_treasury"
      | "move_in"
      | "sweep"
      | "fee_cover",
    company: TestCompany,
    wallet: TestWallet,
    overrides: Partial<NewIntentQuote> = {},
  ) =>
    quoteOf(purpose, company, wallet, {
      recipientType: "CONFIDENTIAL_INTENTS",
      status: "succeeded",
      settledAt: new Date(),
      ledgerCreditedAt: new Date(),
      ...overrides,
    });

  it.each([
    "fund_in",
    "invoice_payment",
    "fund_in_return",
    "from_treasury",
  ] as const)(
    "is allowed on a succeeded %s delivered to a confidential account",
    async (purpose) => {
      // #given
      const { company, wallet } = await companyWithWallet();

      // #when
      const [row] = await insertAs(
        company,
        await credited(purpose, company, wallet),
      );

      // #then
      expect(row?.ledgerCreditedAt).toBeInstanceOf(Date);
    },
  );

  it("is empty unless set", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(company, quote(company, wallet));

    // #then
    expect(row?.ledgerCreditedAt).toBeNull();
  });

  it.each([
    [
      "a quote that has not succeeded",
      "fund_in" as const,
      { status: "depositing" as const, settledAt: null },
    ],
    [
      "a delivery to a destination chain",
      "fund_in" as const,
      { recipientType: "DESTINATION_CHAIN" as const },
    ],
    ["a move-in", "move_in" as const, {}],
    ["a sweep", "sweep" as const, {}],
    ["a fee cover", "fee_cover" as const, {}],
  ])("rejects it on %s", async (_name, purpose, overrides) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      await credited(purpose, company, wallet, overrides),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: {
        constraint: "intent_quotes_ledger_credit_is_confidential_delivery",
      },
    });
  });
});

describe("a wallet's confidential reading", () => {
  const setReading = (
    company: TestCompany,
    wallet: TestWallet,
    reading: {
      confidentialUsdc: bigint | null;
      confidentialUsdcReadAt: Date | null;
    },
  ) =>
    runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx.update(wallets).set(reading).where(eq(wallets.id, wallet.id)),
    );

  it("starts unread", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({
            usdc: wallets.confidentialUsdc,
            readAt: wallets.confidentialUsdcReadAt,
          })
          .from(wallets)
          .where(eq(wallets.id, wallet.id)),
    );

    // #then
    expect(row).toEqual({ usdc: null, readAt: null });
  });

  it("saves a balance with the time it was read, zero included", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const update = setReading(company, wallet, {
      confidentialUsdc: 0n,
      confidentialUsdcReadAt: new Date(),
    });

    // #then
    await expect(update).resolves.toBeDefined();
  });

  it.each([
    ["a balance without the time it was read", 5n, null],
    ["a time without a balance", null, new Date()],
  ])("rejects %s", async (_name, confidentialUsdc, confidentialUsdcReadAt) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const update = setReading(company, wallet, {
      confidentialUsdc,
      confidentialUsdcReadAt,
    });

    // #then
    await expect(update).rejects.toMatchObject({
      cause: { constraint: "wallets_confidential_reading_is_whole" },
    });
  });
});

describe("the confidential account lookups", () => {
  const rows = <Row extends Record<string, unknown>>(
    statement: ReturnType<typeof sql>,
  ) =>
    runInScope(db, {}, (tx) => tx.execute<Row>(statement)).then(
      ({ rows: found }) => found,
    );

  const switchTo = (
    company: TestCompany,
    wallet: TestWallet,
    balanceHome: "company_wallet" | "confidential_account",
  ) =>
    runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx.update(wallets).set({ balanceHome }).where(eq(wallets.id, wallet.id)),
    );

  it("lists the wallets whose money is in a confidential account, with the company's name", async () => {
    // #given one company switched and one not
    const on = await companyWithWallet();
    const off = await companyWithWallet();
    await switchTo(on.company, on.wallet, "confidential_account");

    // #when
    const listed = await rows<{
      wallet_id: string;
      organization_id: string;
      organization_name: string;
      address: string;
    }>(sql`SELECT * FROM confidential_account_wallets()`);

    // #then
    expect({
      on: listed.find((row) => row.wallet_id === on.wallet.id),
      off: listed.some((row) => row.wallet_id === off.wallet.id),
    }).toEqual({
      on: {
        wallet_id: on.wallet.id,
        organization_id: on.company.organizationId,
        organization_name: on.company.name,
        address: on.wallet.address,
      },
      off: false,
    });
  });

  it("leaves out a wallet that is not active", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome: "confidential_account", status: "creating" })
        .where(eq(wallets.id, wallet.id)),
    );

    // #when
    const listed = await rows<{ wallet_id: string }>(
      sql`SELECT wallet_id FROM confidential_account_wallets()`,
    );

    // #then
    expect(listed.some((row) => row.wallet_id === wallet.id)).toBe(false);
  });

  it("lists the deliveries that succeeded and are not in the ledger yet, newest first", async () => {
    // #given an older and a newer one waiting, a Move to wallet, one
    // credited, one still open, one delivered to a destination chain, and a
    // move-in, a sweep and a fee cover, which are never credited
    const { company, wallet } = await companyWithWallet();
    const settled = (minutesAgo: number) => ({
      status: "succeeded" as const,
      settledAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    const confidential = {
      recipientType: "CONFIDENTIAL_INTENTS" as const,
    };
    const save = async (
      purpose: Exclude<IntentQuotePurpose, "move_out">,
      overrides: Partial<NewIntentQuote>,
    ) => {
      const [row] = await insertAs(
        company,
        await quoteOf(purpose, company, wallet, overrides),
      );
      if (!row) throw new Error("quote insert returned no row");
      return row.id;
    };
    const newer = await save("fund_in", { ...confidential, ...settled(1) });
    const older = await save("fund_in_return", {
      ...confidential,
      ...settled(5),
    });
    const done = await save("fund_in", {
      ...confidential,
      ...settled(9),
      ledgerCreditedAt: new Date(),
    });
    const open = await save("fund_in", confidential);
    const onChain = await save("fund_in", settled(3));
    const moveIn = await save("move_in", { ...confidential, ...settled(4) });
    const returned = await save("from_treasury", {
      ...confidential,
      ...settled(2),
    });
    const swept = await save("sweep", { ...confidential, ...settled(6) });
    const covered = await save("fee_cover", { ...confidential, ...settled(7) });
    const mine = new Set([
      newer,
      older,
      done,
      open,
      onChain,
      moveIn,
      returned,
      swept,
      covered,
    ]);

    // #when
    const due = await rows<{ quote_id: string; organization_id: string }>(
      sql`SELECT quote_id, organization_id FROM confidential_quotes_to_credit(1000)`,
    );

    // #then
    expect(
      due
        .filter((row) => mine.has(row.quote_id))
        .map((row) => [row.quote_id, row.organization_id]),
    ).toEqual([
      [newer, company.organizationId],
      [returned, company.organizationId],
      [older, company.organizationId],
    ]);
  });

  it("returns no more than it is asked for", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    await insertAs(
      company,
      await quoteOf("fund_in", company, wallet, {
        recipientType: "CONFIDENTIAL_INTENTS",
        status: "succeeded",
        settledAt: new Date(),
      }),
    );

    // #when
    const due = await rows(
      sql`SELECT quote_id FROM confidential_quotes_to_credit(0)`,
    );

    // #then
    expect(due).toHaveLength(0);
  });
});
