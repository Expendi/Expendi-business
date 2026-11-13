import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NewBill } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { CardCompany } from "../helpers/card-purchases.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingSyncs,
  bills,
  cardLoads,
  cardPurchases,
  expenses,
  notificationOutbox,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { readExportData } from "../../services/export/data.js";
import { monthBounds } from "../../services/export/month.js";
import { exportSheets } from "../../services/export/render.js";
import {
  queueBalanceWarnings,
  queueBillReminders,
} from "../../services/notification/reminders.js";
import { checkCash } from "../../services/overview/cash-check.js";
import { getSpendingOverview } from "../../services/overview/overview.js";
import {
  enqueuePaidBill,
  enqueueRecordedSpending,
} from "../../services/zoho/enqueue.js";
import { syncAccountingItem } from "../../services/zoho/sync.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import {
  addCompanyHeldCard,
  createCardCompany,
} from "../helpers/card-purchases.js";
import { addCategory } from "../helpers/claims.js";
import { createCompany } from "../helpers/db.js";
import { makeFakeZoho } from "../helpers/fakes.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { connectZoho } from "../helpers/zoho.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * What a company-held card's bills mean beyond the Bills page (spec §6.20,
 * §6.24, §6.10, §6.11, §6.17): the cash check weighs them against the Card
 * balance, reminders wait for them to go overdue, and a bill a Card
 * purchase paid reaches the export and Zoho once, as the bill.
 */

const zoho = makeFakeZoho();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let staff: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { zoho: zoho.layer },
    { ACCOUNTING_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  staff = await createStaff(owner);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const USDC = 1_000_000n;
const TODAY = "2026-11-02";

let card: CardCompany;
let cardId: string;
let anthropicId: string;

beforeEach(async () => {
  zoho.state.reset();
  card = await createCardCompany(db, { loadedUsdCents: 5_000n });
  ({ cardId } = await addCompanyHeldCard(db, card.company, {
    defaultCategoryId: card.categoryId,
  }));
  anthropicId = await insertPayee(db, card.company, {
    kind: "vendor",
    name: "Anthropic",
    method: "outside",
  });
});

const adminScope = (company: TestCompany = card.company) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

/**
 * A monthly payment the company-held card pays, by default next billed
 * after the window, on the day of the month `nextDueOn` falls on.
 */
function cardPaidItem(
  amountUsdc: bigint | null,
  { nextDueOn = "2026-12-05" }: { readonly nextDueOn?: string } = {},
): Promise<string> {
  return insertRecurringItem(db, card.company, {
    payeeId: anthropicId,
    categoryId: card.categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc,
    scheduleDay: Number(nextDueOn.slice(8)),
    startsOn: "2026-01-01",
    nextDueOn,
    payVia: "card",
    cardId,
  });
}

function cardPaidBill(
  itemId: string,
  values: Partial<NewBill> & Pick<NewBill, "dueOn">,
): Promise<string> {
  const amountUsdc = values.amountUsdc ?? null;
  return insertBill(db, card.company, {
    payeeId: anthropicId,
    categoryId: card.categoryId,
    recurringItemId: itemId,
    overviewHeading: "subscriptions",
    variable: amountUsdc === null,
    currency: "usd",
    amountKes: null,
    ...values,
  });
}

const window = (days: number, today = TODAY) =>
  runtime.runPromise(
    checkCash({ organizationId: card.company.organizationId, today, days }),
  );

/**
 * A purchase held on the company-held card, which the Card balance no
 * longer has; matched to `recurringItemId` when given.
 */
async function holdOnCard(
  usdCents: bigint,
  recurringItemId: string | null = null,
): Promise<void> {
  await runInScope(db, adminScope(), (tx) =>
    tx.insert(cardPurchases).values({
      organizationId: card.company.organizationId,
      cardId,
      lithicTransactionToken: randomUUID(),
      status: "pending",
      merchant: "VERCEL",
      mcc: "5734",
      holdUsdCents: usdCents,
      authorizedAt: new Date(`${TODAY}T08:00:00Z`),
      categoryId: card.categoryId,
      recurringItemId,
    }),
  );
}

describe("the cash check", () => {
  it("weighs card-paid bills and forecasts against the Card balance, apart from the wallet", async () => {
    // #given USD 20.00 billed, a bill with no estimate, and USD 15.004 forecast
    const billed = await cardPaidItem(20n * USDC);
    const billId = await cardPaidBill(billed, {
      dueOn: "2026-11-05",
      amountUsdc: 20n * USDC,
    });
    const unknown = await cardPaidItem(null);
    const unknownBillId = await cardPaidBill(unknown, { dueOn: "2026-11-07" });
    const forecast = await cardPaidItem(15_004_000n, {
      nextDueOn: "2026-11-12",
    });
    // KES 1,000 paid outside, KES 500 through Expendi
    await insertBill(db, card.company, {
      payeeId: anthropicId,
      categoryId: card.categoryId,
      amountKes: 100_000n,
      dueOn: "2026-11-04",
    });
    const supplierId = await insertPayee(db, card.company, { name: "Rent" });
    await insertBill(db, card.company, {
      payeeId: supplierId,
      categoryId: card.categoryId,
      amountKes: 50_000n,
      dueOn: "2026-11-03",
    });

    // #when
    const covered = await window(30);
    await holdOnCard(2_000n);
    const short = await window(30);

    // #then 2,000 + 1,501 (15.004 rounded up) US cents against USD 50.00
    expect(covered).toMatchObject({
      totalKes: 50_000n,
      outsideKes: 100_000n,
      unknownAmounts: 0,
      cardBills: {
        dueUsdCents: 3_501n,
        availableUsdCents: 5_000n,
        short: false,
      },
    });
    expect(short.cardBills).toEqual({
      dueUsdCents: 3_501n,
      availableUsdCents: 3_000n,
      short: true,
    });
    const byCard = covered.obligations.filter((row) => row.payVia === "card");
    expect(byCard).toEqual([
      expect.objectContaining({
        id: billId,
        kind: "bill",
        card: {
          id: cardId,
          nickname: "Software subscriptions",
          lastFour: "1881",
        },
        amountUsdCents: 2_000n,
        needsAmount: false,
      }),
      expect.objectContaining({
        id: unknownBillId,
        kind: "bill",
        amountUsdCents: null,
        needsAmount: false,
      }),
      expect.objectContaining({
        id: forecast,
        kind: "forecast",
        dueOn: "2026-11-12",
        amountUsdCents: 1_501n,
      }),
    ]);
  });

  it("has nothing for the cards when no card-paid bill falls in the window", async () => {
    // #given one due after the window
    const itemId = await cardPaidItem(20n * USDC);
    await cardPaidBill(itemId, {
      dueOn: "2026-11-20",
      amountUsdc: 20n * USDC,
    });

    // #when
    const week = await window(7);
    const month = await window(30);

    // #then
    expect(week.cardBills).toBeNull();
    expect(month.cardBills).toMatchObject({ dueUsdCents: 2_000n });
  });

  it("has nothing for the cards in a company that hasn't turned cards on", async () => {
    // #given a card-paid payment in a company with no card program
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Software");
    const other = await addCompanyHeldCard(db, company, {
      defaultCategoryId: categoryId,
    });
    const payeeId = await insertPayee(db, company, { name: "Anthropic" });
    const itemId = await insertRecurringItem(db, company, {
      payeeId,
      categoryId,
      currency: "usd",
      amountKes: null,
      amountUsdc: 20n * USDC,
      nextDueOn: "2026-11-05",
      payVia: "card",
      cardId: other.cardId,
    });

    // #when
    const cash = await runtime.runPromise(
      checkCash({
        organizationId: company.organizationId,
        today: TODAY,
        days: 30,
      }),
    );

    // #then
    expect(cash.obligations.map((row) => row.id)).toEqual([itemId]);
    expect(cash.cardBills).toBeNull();
  });

  it("reaches the overview as the Card balance check, each card-paid row paid outside the wallet", async () => {
    // #given
    const itemId = await cardPaidItem(20n * USDC);
    const billId = await cardPaidBill(itemId, {
      dueOn: "2026-11-05",
      amountUsdc: 20n * USDC,
    });

    // #when
    const overview = await runtime.runPromise(
      getSpendingOverview(
        { ...adminScope(), membershipId: card.company.adminMembershipId },
        undefined,
        new Date("2026-11-02T09:00:00Z"),
      ),
    );

    // #then
    expect(overview.cash.cardBills).toEqual({
      dueUsdCents: "2000",
      availableUsdCents: "5000",
      short: false,
    });
    expect(overview.cash.obligations).toEqual([
      expect.objectContaining({
        id: billId,
        payVia: "outside",
        needsAmount: false,
        card: {
          id: cardId,
          nickname: "Software subscriptions",
          lastFour: "1881",
        },
        amountUsdCents: "2000",
      }),
    ]);
    expect(overview.cash).toMatchObject({ totalKes: "0", outsideKes: "0" });
  });
});

const outboxOf = (billId: string | null) =>
  runInScope(db, adminScope(), (tx) =>
    tx
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, card.company.organizationId))
      .orderBy(
        asc(notificationOutbox.createdAt),
        asc(notificationOutbox.channel),
      ),
  ).then((rows) =>
    rows.filter((row) => billId === null || row.data.billId === billId),
  );

const remind = (today: string) =>
  runtime.runPromise(
    withScope(adminScope(), (tx) =>
      queueBillReminders(tx, card.company.organizationId, today),
    ),
  );

describe("reminders for a card-paid bill", () => {
  it("send nothing before or on the due date, then one overdue reminder about the purchase not arriving", async () => {
    // #given due Thu 5 Nov, reminded 3 days ahead like any other
    const itemId = await cardPaidItem(20n * USDC);
    const billId = await cardPaidBill(itemId, {
      dueOn: "2026-11-05",
      amountUsdc: 20n * USDC,
    });

    // #when
    const soon = await remind("2026-11-03");
    const dueToday = await remind("2026-11-05");
    await runInScope(db, adminScope(), (tx) =>
      tx.update(bills).set({ status: "overdue" }).where(eq(bills.id, billId)),
    );
    const overdue = await remind("2026-11-06");
    const again = await remind("2026-11-07");

    // #then
    expect([soon, dueToday, overdue, again]).toEqual([0, 0, 1, 0]);
    const queued = await outboxOf(billId);
    expect(queued.map((row) => `${row.kind}:${row.channel}`)).toEqual([
      "bill_overdue:email",
      "bill_overdue:push",
    ]);
    expect(queued[0]).toMatchObject({
      title: "Card payment overdue",
      body: "Anthropic hasn't charged card •••• 1881 yet for the bill due Thu 5 Nov. Check the subscription with them, or mark the bill paid if it was paid another way.",
      dedupeKey: `bill_overdue:${billId}`,
    });
  });

  it("leave other bills' reminders as they were", async () => {
    // #given
    const billId = await insertBill(db, card.company, {
      payeeId: anthropicId,
      categoryId: card.categoryId,
      dueOn: "2026-11-05",
    });

    // #when
    const soon = await remind("2026-11-03");

    // #then
    expect(soon).toBe(1);
    expect((await outboxOf(billId))[0]).toMatchObject({
      kind: "bill_due_soon",
      title: "Bill due soon",
    });
  });
});

const warn = (today: string) =>
  runtime.runPromise(queueBalanceWarnings(card.company.organizationId, today));

describe("the Card balance warning", () => {
  it("goes out once a Nairobi day while the card-paid bills of the next 7 days need more than the Card balance", async () => {
    // #given USD 60.00 due by card against USD 50.00
    const itemId = await cardPaidItem(60n * USDC);
    await cardPaidBill(itemId, {
      dueOn: "2026-11-05",
      amountUsdc: 60n * USDC,
    });

    // #when
    const first = await warn(TODAY);
    const sameDay = await warn(TODAY);
    const nextDay = await warn("2026-11-03");

    // #then
    expect([first, sameDay, nextDay]).toEqual([
      { wallet: false, card: true },
      { wallet: false, card: false },
      { wallet: false, card: true },
    ]);
    const warnings = (await outboxOf(null)).filter(
      (row) => row.kind === "card_balance_short",
    );
    expect(warnings.map((row) => row.dedupeKey)).toEqual([
      `card_balance_short:${TODAY}`,
      `card_balance_short:${TODAY}`,
      "card_balance_short:2026-11-03",
      "card_balance_short:2026-11-03",
    ]);
    expect(warnings[0]?.body).toBe(
      "Your company-held cards' recurring payments need USD 60.00 soon, and USD 50.00 is left. Load more so they aren't declined.",
    );
  });

  it("doesn't count a bill whose own Card purchase is already held", async () => {
    // #given USD 100.00 loaded, a USD 60.00 bill, and its USD 60.00
    // purchase on hold
    await runInScope(db, adminScope(), (tx) =>
      tx.insert(cardLoads).values({
        organizationId: card.company.organizationId,
        amountUsdCents: 5_000n,
        amountKes: 645_000n,
        usdKesRate: "129",
        loadedBy: card.company.admin.id,
        approvalId: randomUUID(),
      }),
    );
    const itemId = await cardPaidItem(60n * USDC);
    await cardPaidBill(itemId, {
      dueOn: "2026-11-05",
      amountUsdc: 60n * USDC,
    });
    await holdOnCard(6_000n, itemId);

    // #when
    const cash = await window(7);
    const warned = await warn(TODAY);

    // #then
    expect(cash.cardBills).toEqual({
      dueUsdCents: 0n,
      availableUsdCents: 4_000n,
      short: false,
    });
    expect(warned).toEqual({ wallet: false, card: false });
    expect(
      (await outboxOf(null)).filter((row) => row.kind === "card_balance_short"),
    ).toEqual([]);
  });

  it("stays quiet while the Card balance covers them", async () => {
    // #given
    const itemId = await cardPaidItem(50n * USDC);
    await cardPaidBill(itemId, {
      dueOn: "2026-11-05",
      amountUsdc: 50n * USDC,
    });

    // #when
    const warned = await warn(TODAY);

    // #then
    expect(warned).toEqual({ wallet: false, card: false });
    expect(await outboxOf(null)).toEqual([]);
  });
});

/**
 * A USD 21.50 Card purchase paid the bill on 2 Nov, recorded as KES 2,770
 * of card spending from the "Expendi cards" account.
 */
async function paidByCard(): Promise<{ billId: string; spendingId: string }> {
  const itemId = await cardPaidItem(20n * USDC);
  return runInScope(db, adminScope(), async (tx) => {
    const [purchase] = await tx
      .insert(cardPurchases)
      .values({
        organizationId: card.company.organizationId,
        cardId,
        lithicTransactionToken: randomUUID(),
        status: "settled",
        merchant: "ANTHROPIC",
        mcc: "5734",
        settledUsdCents: 2_150n,
        authorizedAt: new Date("2026-11-02T06:00:00Z"),
        categoryId: card.categoryId,
        recurringItemId: itemId,
      })
      .returning({ id: cardPurchases.id });
    if (!purchase) throw new Error("purchase insert returned no row");
    const [bill] = await tx
      .insert(bills)
      .values({
        organizationId: card.company.organizationId,
        payeeId: anthropicId,
        recurringItemId: itemId,
        overviewHeading: "subscriptions",
        categoryId: card.categoryId,
        currency: "usd",
        amountUsdc: 21_500_000n,
        dueOn: TODAY,
        status: "paid_by_card",
        paidOn: TODAY,
        paidAt: new Date("2026-11-02T06:05:00Z"),
        cardPurchaseId: purchase.id,
      })
      .returning({ id: bills.id });
    if (!bill) throw new Error("bill insert returned no row");
    const [spending] = await tx
      .insert(expenses)
      .values({
        organizationId: card.company.organizationId,
        membershipId: card.company.adminMembershipId,
        kind: "card",
        status: "recorded",
        overviewHeading: "subscriptions",
        paidFromAccountId: card.accountId,
        billId: bill.id,
        categoryId: card.categoryId,
        merchant: "Anthropic",
        amountKes: 277_000n,
        spentOn: TODAY,
      })
      .returning({ id: expenses.id });
    if (!spending) throw new Error("spending insert returned no row");
    await tx
      .update(cardPurchases)
      .set({ billId: bill.id, expenseId: spending.id, usdKesRate: "128.84" })
      .where(eq(cardPurchases.id, purchase.id));
    return { billId: bill.id, spendingId: spending.id };
  });
}

describe("a bill paid by a Card purchase in the books", () => {
  it("is in the month's export once, as the bill, in KES and paid by Expendi card", async () => {
    // #given
    const { billId, spendingId } = await paidByCard();

    // #when
    const data = await runtime.runPromise(
      withScope(adminScope(), (tx) =>
        readExportData(tx, card.company.organizationId, monthBounds("2026-11")),
      ),
    );
    const sheets = exportSheets(data, "2026-11");

    // #then
    expect(
      data.moneyOut.map(({ id, kind, amountKes, status }) => ({
        id,
        kind,
        amountKes,
        status,
      })),
    ).toEqual([
      { id: billId, kind: "bill", amountKes: 277_000n, status: "paid_by_card" },
    ]);
    expect(data.moneyOut.map((row) => row.id)).not.toContain(spendingId);
    expect(data.outstanding.map((row) => row.id)).not.toContain(billId);
    const [header, row] = sheets.moneyOut.rows;
    const column = (name: string) => header?.indexOf(name) ?? -1;
    expect(row?.[column("Status")]).toBe("Paid by Expendi card");
    expect(row?.[column("Payee or employee")]).toBe("Anthropic");
  });

  it("is one of the overview's recent payments, as the bill, paid through Expendi, and asks for no receipt", async () => {
    // #given
    const { billId, spendingId } = await paidByCard();

    // #when
    const overview = await runtime.runPromise(
      getSpendingOverview(
        { ...adminScope(), membershipId: card.company.adminMembershipId },
        undefined,
        new Date("2026-11-02T09:00:00Z"),
      ),
    );

    // #then
    expect(overview.recentPayments).toEqual([
      expect.objectContaining({
        id: spendingId,
        subjectId: billId,
        kind: "bill",
        name: "Anthropic",
        amountKes: "277000",
        heading: "subscriptions",
        channel: "expendi",
      }),
    ]);
    expect(overview.outstanding.noReceipt).toEqual([]);
  });

  it("is posted to Zoho once, as the bill, from the Expendi cards account, and its spending row never on its own", async () => {
    // #given the "Expendi cards" account mapped in Zoho
    zoho.state.accounts.push(
      { id: "acc-salaries", name: "Salaries", code: "6200", type: "expense" },
      { id: "acc-cards", name: "Expendi cards", code: null, type: "bank" },
    );
    await connectZoho(app, staff, card.company, {
      categoryAccounts: { [card.categoryId]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
      pettyCashAccountId: "acc-petty",
      salariesAccountId: "acc-salaries",
      paidFromAccounts: { [card.accountId]: "acc-cards" },
    });
    const { billId, spendingId } = await paidByCard();

    // #when queued as paying it by card and recording its spending do
    await runtime.runPromise(
      withScope(adminScope(), (tx) =>
        Effect.all([
          enqueueRecordedSpending(tx, card.company.organizationId, spendingId),
          enqueuePaidBill(tx, card.company.organizationId, billId),
          enqueuePaidBill(tx, card.company.organizationId, billId),
        ]),
      ),
    );
    const syncs = await runInScope(
      db,
      { organizationId: card.company.organizationId },
      (tx) =>
        tx
          .select()
          .from(accountingSyncs)
          .where(
            and(
              eq(accountingSyncs.organizationId, card.company.organizationId),
            ),
          ),
    );
    const outcomes = [];
    for (const sync of syncs) {
      outcomes.push(
        await runtime.runPromise(
          syncAccountingItem(card.company.organizationId, sync.id),
        ),
      );
    }

    // #then
    expect(
      syncs.map(({ subjectType, subjectId }) => [subjectType, subjectId]),
    ).toEqual([["bill", billId]]);
    expect(outcomes).toEqual(["synced"]);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      expect.objectContaining({
        accountId: "acc-travel",
        paidThroughAccountId: "acc-cards",
        date: TODAY,
        amount: "2770.00",
        referenceNumber: billId,
      }),
    ]);
  });
});
