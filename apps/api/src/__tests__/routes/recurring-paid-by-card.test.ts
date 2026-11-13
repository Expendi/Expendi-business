import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateRecurringItemRequest,
  RecurringItem,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  billsResponseSchema,
  billsSummarySchema,
  recurringItemSchema,
  recurringItemsResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { BillRow, CardMerchant } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  CardCompany,
  CompanyHeldCard,
} from "../helpers/card-purchases.js";
import type { TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  bills,
  cardMerchants,
  cardPurchases,
  expenses,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { getBillPaymentReceiptData } from "../../services/bills/payment-receipt.js";
import { nairobiDate } from "../../services/bills/status.js";
import {
  insertBill,
  insertBillPayout,
  insertPayee,
  readBill,
  shiftDays,
} from "../helpers/bills.js";
import {
  addCompanyHeldCard,
  createCardCompany,
} from "../helpers/card-purchases.js";
import { sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { addEmployeePayee, insertSalary } from "../helpers/payroll.js";
import {
  insertRecurringItem,
  outstandingBillsOfItem,
  readRecurringItem,
} from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Recurring payments a company-held card pays (spec §6.20), and their bills
 * before a Card purchase pays them: set up, switched, moved between cards,
 * never paid through Expendi, and a `paid_by_card` bill settled for good.
 */

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let card: CardCompany;
let companyCard: CompanyHeldCard;
let anthropicId: string;
let today: string;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  card = await createCardCompany(db);
  companyCard = await addCompanyHeldCard(db, card.company, {
    defaultCategoryId: card.categoryId,
  });
  anthropicId = await insertPayee(db, card.company, {
    kind: "vendor",
    name: "Anthropic",
    method: "outside",
  });
  today = nairobiDate(new Date());
});

const USDC = 1_000_000n;

const orgPath = (rest: string) =>
  `/organizations/${card.company.organizationId}${rest}`;

function send(
  method: string,
  path: string,
  body?: unknown,
  user: Pick<TestUser, "privyUserId"> = card.company.admin,
): Promise<Response> {
  return sendJson(app, orgPath(path), user, { method, body });
}

async function dataOf<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  const { data } = (await response.json()) as { data: unknown };
  return schema.parse(data);
}

async function errorOf(response: Response) {
  return (
    (await response.json()) as {
      error: { message: string; details?: Record<string, unknown> };
    }
  ).error;
}

const isoWeekday = (isoDate: string): number =>
  ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Weekly, by the company-held card, the first bill due 10 days from today. */
function byCard(
  overrides: Partial<CreateRecurringItemRequest> = {},
): CreateRecurringItemRequest {
  const startsOn = shiftDays(today, 10);
  return {
    payeeId: anthropicId,
    amountUsd: "20",
    schedule: "weekly",
    scheduleDay: isoWeekday(startsOn),
    startsOn,
    payVia: "card",
    cardId: companyCard.cardId,
    overviewHeading: "subscriptions",
    categoryId: card.categoryId,
    ...overrides,
  };
}

async function createItem(
  request: CreateRecurringItemRequest,
): Promise<RecurringItem> {
  const response = await send("POST", "/recurring-items", request);
  expect(response.status, await response.clone().text()).toBe(201);
  return dataOf(response, recurringItemSchema);
}

const patchItem = (itemId: string, body: unknown) =>
  send("PATCH", `/recurring-items/${itemId}`, body);

async function openBillOf(itemId: string): Promise<BillRow> {
  const [bill] = await outstandingBillsOfItem(db, card.company, itemId);
  if (!bill) throw new Error(`item ${itemId} has no open bill`);
  return bill;
}

async function auditOf(entityType: string, entityId: string) {
  const { rows } = await owner.query<{
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    "SELECT action, before, after FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY occurred_at, id",
    [entityType, entityId],
  );
  return rows;
}

/**
 * Until a session waits for a `card_merchants` row, or a few seconds pass.
 * Only a waiter holds a tuple lock.
 */
async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await owner.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'tuple' AND relation = 'card_merchants'::regclass",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const adminScope = () => ({
  organizationId: card.company.organizationId,
  userId: card.company.admin.id,
  role: "admin" as const,
});

/** A card-paid weekly payment written straight to the table, with its open bill. */
async function cardPaidItem(
  values: { cardId?: string; amountUsdc?: bigint | null } = {},
): Promise<{ itemId: string; billId: string }> {
  const amountUsdc =
    values.amountUsdc === undefined ? 20n * USDC : values.amountUsdc;
  const itemId = await insertRecurringItem(db, card.company, {
    payeeId: anthropicId,
    categoryId: card.categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc,
    schedule: "weekly",
    scheduleDay: isoWeekday(shiftDays(today, 3)),
    startsOn: today,
    nextDueOn: shiftDays(today, 10),
    payVia: "card",
    cardId: values.cardId ?? companyCard.cardId,
  });
  const billId = await insertBill(db, card.company, {
    payeeId: anthropicId,
    categoryId: card.categoryId,
    recurringItemId: itemId,
    overviewHeading: "subscriptions",
    variable: amountUsdc === null,
    currency: "usd",
    amountKes: null,
    amountUsdc,
    dueOn: shiftDays(today, 3),
    status: "upcoming",
  });
  return { itemId, billId };
}

async function addMerchant(
  values: Pick<CardMerchant, "cardId" | "merchantKey"> &
    Partial<Pick<CardMerchant, "recurringItemId" | "blocked">>,
): Promise<string> {
  const [row] = await runInScope(db, adminScope(), (tx) =>
    tx
      .insert(cardMerchants)
      .values({
        organizationId: card.company.organizationId,
        descriptor: values.merchantKey.toUpperCase(),
        ...values,
      })
      .returning({ id: cardMerchants.id }),
  );
  if (!row) throw new Error("merchant insert returned no row");
  return row.id;
}

const merchantsOf = (cardId: string) =>
  runInScope(db, adminScope(), (tx) =>
    tx
      .select()
      .from(cardMerchants)
      .where(eq(cardMerchants.cardId, cardId))
      .orderBy(cardMerchants.merchantKey),
  );

/**
 * A USD 21.50 Card purchase paid the bill, recorded as KES 2,770.00 card
 * spending from the "Expendi cards" account, as paying it by card leaves it.
 */
async function payByCard(billId: string): Promise<{ purchaseId: string }> {
  const bill = await readBill(db, card.company, billId);
  return runInScope(db, adminScope(), async (tx) => {
    const [purchase] = await tx
      .insert(cardPurchases)
      .values({
        organizationId: card.company.organizationId,
        cardId: companyCard.cardId,
        lithicTransactionToken: randomUUID(),
        status: "settled",
        merchant: "ANTHROPIC",
        merchantKey: "anthropic",
        mcc: "5734",
        settledUsdCents: 2_150n,
        authorizedAt: new Date(),
        categoryId: card.categoryId,
        recurringItemId: bill.recurringItemId,
      })
      .returning({ id: cardPurchases.id });
    if (!purchase) throw new Error("purchase insert returned no row");
    await tx
      .update(bills)
      .set({
        status: "paid_by_card",
        currency: "usd",
        amountKes: null,
        amountUsdc: 21_500_000n,
        variable: false,
        paidOn: today,
        paidAt: new Date(),
        cardPurchaseId: purchase.id,
      })
      .where(eq(bills.id, billId));
    const [spending] = await tx
      .insert(expenses)
      .values({
        organizationId: card.company.organizationId,
        membershipId: card.company.adminMembershipId,
        kind: "card",
        status: "recorded",
        overviewHeading: "subscriptions",
        paidFromAccountId: card.accountId,
        billId,
        categoryId: card.categoryId,
        merchant: "Anthropic",
        amountKes: 277_000n,
        spentOn: today,
      })
      .returning({ id: expenses.id });
    if (!spending) throw new Error("spending insert returned no row");
    await tx
      .update(cardPurchases)
      .set({ billId, expenseId: spending.id, usdKesRate: "128.84" })
      .where(eq(cardPurchases.id, purchase.id));
    return { purchaseId: purchase.id };
  });
}

describe("setting up a recurring payment paid by a company-held card", () => {
  it("bills in USD for a payee paid outside Expendi, and shows the card in the list and on its own", async () => {
    // #when
    const item = await createItem(byCard());
    const listed = await dataOf(
      await send("GET", "/recurring-items"),
      recurringItemsResponseSchema,
    );
    const alone = await dataOf(
      await send("GET", `/recurring-items/${item.id}`),
      recurringItemSchema,
    );

    // #then
    const shown = {
      payVia: "card",
      currency: "usd",
      amountKes: null,
      amountUsdc: "20000000",
      card: {
        id: companyCard.cardId,
        nickname: "Software subscriptions",
        lastFour: "1881",
        state: "open",
      },
      nextBill: { currency: "usd", amountKes: null, amountUsdc: "20000000" },
    };
    expect(item).toMatchObject(shown);
    expect(listed.find((each) => each.id === item.id)).toMatchObject(shown);
    expect(alone).toMatchObject(shown);
    const [created] = await auditOf("recurring_item", item.id);
    expect(created).toMatchObject({
      action: "recurring_item.created",
      after: { payVia: "card", cardId: companyCard.cardId, currency: "usd" },
    });
  });

  it("takes a payment with no estimate, and a frozen card", async () => {
    // #given
    const frozen = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      state: "frozen",
      lastFour: "7007",
    });

    // #when
    const item = await createItem(
      byCard({ amountUsd: undefined, variable: true, cardId: frozen.cardId }),
    );

    // #then
    expect(item).toMatchObject({
      variable: true,
      currency: "usd",
      amountUsdc: null,
      card: { id: frozen.cardId, state: "frozen" },
      nextBill: { currency: "usd", amountUsdc: null },
    });
  });

  it("refuses a person's card, another company's company-held card, and an amount in KES", async () => {
    // #given
    const other = await createCardCompany(db);
    const othersCard = await addCompanyHeldCard(db, other.company, {
      defaultCategoryId: other.categoryId,
    });

    // #when
    const personal = await send(
      "POST",
      "/recurring-items",
      byCard({ cardId: card.cardId }),
    );
    const foreign = await send(
      "POST",
      "/recurring-items",
      byCard({ cardId: othersCard.cardId }),
    );
    const inKes = await send(
      "POST",
      "/recurring-items",
      byCard({ amountUsd: undefined, amountKes: "2,500" }),
    );

    // #then
    for (const response of [personal, foreign]) {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toBe(
        "Pick one of the company's company-held cards.",
      );
    }
    expect(inKes.status).toBe(400);
    expect((await errorOf(inKes)).message).toBe(
      "A payment by company-held card is estimated in USD. Enter the amount in USD.",
    );
  });

  it("refuses a closed company-held card", async () => {
    // #given
    const closed = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      state: "closed",
      closedAt: new Date(),
      lastFour: "4040",
    });

    // #when
    const response = await send(
      "POST",
      "/recurring-items",
      byCard({ cardId: closed.cardId }),
    );

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "Card •••• 4040 is closed. Pick another company-held card.",
    );
  });
});

describe("switching a recurring payment to a company-held card", () => {
  it("moves a payment made outside Expendi to USD and rewrites its open bill with the estimate", async () => {
    // #given KES 2,500 a week, paid outside
    const item = await createItem(
      byCard({
        payVia: "outside",
        cardId: undefined,
        amountUsd: undefined,
        amountKes: "2,500",
      }),
    );
    const before = await openBillOf(item.id);
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({ status: "overdue" })
        .where(eq(bills.id, before.id)),
    );

    // #when
    const switched = await dataOf(
      await patchItem(item.id, {
        payVia: "card",
        cardId: companyCard.cardId,
        amountUsd: "20",
      }),
      recurringItemSchema,
    );

    // #then
    expect(switched).toMatchObject({
      payVia: "card",
      currency: "usd",
      amountKes: null,
      amountUsdc: "20000000",
      card: { id: companyCard.cardId },
    });
    expect(await readBill(db, card.company, before.id)).toMatchObject({
      status: "overdue",
      currency: "usd",
      amountKes: null,
      amountUsdc: 20n * USDC,
      variable: false,
    });
    const audit = await auditOf("recurring_item", item.id);
    expect(audit.at(-1)).toMatchObject({
      action: "recurring_item.updated",
      before: { payVia: "outside", cardId: null, currency: "kes" },
      after: { payVia: "card", cardId: companyCard.cardId, currency: "usd" },
    });
    expect((await auditOf("bill", before.id)).at(-1)).toMatchObject({
      action: "bill.updated",
      before: { currency: "kes", amountKes: "250000" },
      after: { currency: "usd", amountKes: null, amountUsdc: "20000000" },
    });
  });

  it("drops a KES amount when no estimate comes with it, leaving the payment and its bill variable", async () => {
    // #given a supplier paid through Expendi, KES 2,500
    const supplierId = await insertPayee(db, card.company, {
      name: "Hosting Co",
    });
    const item = await createItem(
      byCard({
        payeeId: supplierId,
        payVia: "expendi",
        cardId: undefined,
        amountUsd: undefined,
        amountKes: "2,500",
      }),
    );

    // #when
    const switched = await dataOf(
      await patchItem(item.id, { payVia: "card", cardId: companyCard.cardId }),
      recurringItemSchema,
    );

    // #then
    expect(switched).toMatchObject({
      payVia: "card",
      variable: true,
      currency: "usd",
      amountKes: null,
      amountUsdc: null,
    });
    expect(await openBillOf(item.id)).toMatchObject({
      currency: "usd",
      amountKes: null,
      amountUsdc: null,
      variable: true,
    });
  });

  it.each(["paying", "payout_failed"] as const)(
    "is refused while its bill is %s, and changes nothing",
    async (status) => {
      // #given
      const supplierId = await insertPayee(db, card.company, {
        name: "Hosting Co",
      });
      const item = await createItem(
        byCard({
          payeeId: supplierId,
          payVia: "expendi",
          cardId: undefined,
          amountUsd: undefined,
          amountKes: "2,500",
        }),
      );
      const bill = await openBillOf(item.id);
      const wallet = await createActiveWallet(db, card.company);
      const payoutId = await insertBillPayout(db, card.company, wallet.id);
      await runInScope(db, adminScope(), (tx) =>
        tx.update(bills).set({ status, payoutId }).where(eq(bills.id, bill.id)),
      );

      // #when
      const response = await patchItem(item.id, {
        payVia: "card",
        cardId: companyCard.cardId,
        amountUsd: "20",
      });

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toBe(
        status === "paying"
          ? "Its bill is being paid through Expendi. Change how it's paid once that payment finishes."
          : "Its bill's payment through Expendi failed. Retry it, mark it paid or cancel it before changing how it's paid.",
      );
      expect(await readRecurringItem(db, card.company, item.id)).toMatchObject({
        payVia: "expendi",
        cardId: null,
        currency: "kes",
      });
      expect(await readBill(db, card.company, bill.id)).toMatchObject({
        status,
        currency: "kes",
        amountKes: 250_000n,
      });
    },
  );

  it("refuses a salary", async () => {
    // #given
    const person = await addEmployeePayee(db, card.company);
    const salaryId = await insertSalary(db, card.company, {
      payeeId: person.payeeId,
      categoryId: card.categoryId,
    });

    // #when
    const response = await patchItem(salaryId, {
      payVia: "card",
      cardId: companyCard.cardId,
    });

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "This is a salary. Change it in payroll.",
    );
  });
});

describe("switching a recurring payment away from its company-held card", () => {
  it("follows the payee's currency again, clears the bill's estimate and decline, and releases its merchants", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({
          cardDeclinedAt: new Date(),
          cardDeclineReason: "Not enough on the Card balance.",
        })
        .where(eq(bills.id, billId)),
    );
    const linked = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "anthropic",
      recurringItemId: itemId,
    });
    const otherItem = await cardPaidItem();
    const untouched = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "vercel",
      recurringItemId: otherItem.itemId,
    });

    // #when
    const switched = await dataOf(
      await patchItem(itemId, { payVia: "outside" }),
      recurringItemSchema,
    );

    // #then
    expect(switched).toMatchObject({
      payVia: "outside",
      card: null,
      currency: "kes",
      amountKes: null,
      amountUsdc: null,
      variable: true,
    });
    expect(await readBill(db, card.company, billId)).toMatchObject({
      currency: "kes",
      amountKes: null,
      amountUsdc: null,
      variable: true,
      cardDeclinedAt: null,
      cardDeclineReason: null,
    });
    const merchants = await merchantsOf(companyCard.cardId);
    expect(
      merchants.map(({ id, recurringItemId }) => ({ id, recurringItemId })),
    ).toEqual([
      { id: linked, recurringItemId: null },
      { id: untouched, recurringItemId: otherItem.itemId },
    ]);
    expect((await auditOf("recurring_item", itemId)).at(-1)).toMatchObject({
      after: {
        payVia: "outside",
        cardId: null,
        cardMerchants: { released: [linked] },
      },
    });
  });

  it("takes its merchants' locks before its bill's, as a declined Card purchase does, so the two queue instead of deadlocking", async () => {
    // #given a declined Card purchase's work, holding the payment's merchant
    // and about to mark its bill
    const { itemId, billId } = await cardPaidItem();
    const merchantId = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "anthropic",
      recurringItemId: itemId,
    });
    let markBill = (): void => undefined;
    const marking = new Promise<void>((resolve) => {
      markBill = resolve;
    });
    let merchantHeld = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      merchantHeld = resolve;
    });
    const declinedPurchase = runInScope(db, adminScope(), async (tx) => {
      await tx
        .select({ id: cardMerchants.id })
        .from(cardMerchants)
        .where(eq(cardMerchants.id, merchantId))
        .for("update");
      merchantHeld();
      await marking;
      await tx
        .update(bills)
        .set({ cardDeclinedAt: new Date(), cardDeclineReason: "Frozen." })
        .where(eq(bills.id, billId));
    });
    await holding;

    // #when the payment is switched away from the card meanwhile
    const switching = patchItem(itemId, { payVia: "outside" });
    await waitForLockWait();
    markBill();
    const marked = await Promise.allSettled([declinedPurchase]);
    const switched = await switching;

    // #then
    expect(marked.map((result) => result.status)).toEqual(["fulfilled"]);
    expect(switched.status, await switched.clone().text()).toBe(200);
    expect(await merchantsOf(companyCard.cardId)).toEqual([
      expect.objectContaining({ id: merchantId, recurringItemId: null }),
    ]);
  });

  it("keeps the amount a new one brings, in the payee's currency", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();

    // #when
    const switched = await dataOf(
      await patchItem(itemId, { payVia: "outside", amountKes: "2,600" }),
      recurringItemSchema,
    );

    // #then
    expect(switched).toMatchObject({ currency: "kes", amountKes: "260000" });
    expect(await readBill(db, card.company, billId)).toMatchObject({
      currency: "kes",
      amountKes: 260_000n,
      variable: false,
    });
  });

  it("can't move a payee paid outside Expendi to paying through it", async () => {
    // #given
    const { itemId } = await cardPaidItem();

    // #when
    const response = await patchItem(itemId, { payVia: "expendi" });

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      "Anthropic is paid outside Expendi, so this payment is too.",
    );
    expect(await readRecurringItem(db, card.company, itemId)).toMatchObject({
      payVia: "card",
      cardId: companyCard.cardId,
    });
  });
});

describe("moving a recurring payment to another company-held card", () => {
  it("links its merchants on the new card, or the new card's own row unless that one is blocked, and the old card keeps them released", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();
    const newCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      lastFour: "5005",
    });
    const moves = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "anthropic",
      recurringItemId: itemId,
    });
    const seenOnBoth = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "anthropic-eu",
      recurringItemId: itemId,
    });
    const newCardsOwn = await addMerchant({
      cardId: newCard.cardId,
      merchantKey: "anthropic-eu",
    });
    const blockedHere = await addMerchant({
      cardId: companyCard.cardId,
      merchantKey: "claude-ai",
      recurringItemId: itemId,
    });
    const blockedThere = await addMerchant({
      cardId: newCard.cardId,
      merchantKey: "claude-ai",
      blocked: true,
    });
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({ cardDeclinedAt: new Date(), cardDeclineReason: "Frozen." })
        .where(eq(bills.id, billId)),
    );

    // #when
    const moved = await dataOf(
      await patchItem(itemId, { payVia: "card", cardId: newCard.cardId }),
      recurringItemSchema,
    );

    // #then
    expect(moved.card).toMatchObject({ id: newCard.cardId, lastFour: "5005" });
    const links = (rows: CardMerchant[]) =>
      rows.map(({ id, recurringItemId, blocked }) => ({
        id,
        recurringItemId,
        blocked,
      }));
    // The old card still knows them, so none can pay another of its
    // payments as a merchant it has never seen.
    expect(links(await merchantsOf(companyCard.cardId))).toEqual([
      { id: moves, recurringItemId: null, blocked: false },
      { id: seenOnBoth, recurringItemId: null, blocked: false },
      { id: blockedHere, recurringItemId: null, blocked: false },
    ]);
    const onNewCard = await merchantsOf(newCard.cardId);
    const added = onNewCard.find((row) => row.merchantKey === "anthropic");
    expect(links(onNewCard)).toEqual([
      { id: added?.id, recurringItemId: itemId, blocked: false },
      { id: newCardsOwn, recurringItemId: itemId, blocked: false },
      { id: blockedThere, recurringItemId: null, blocked: true },
    ]);
    expect(added?.id).not.toBe(moves);
    expect(added?.descriptor).toBe("ANTHROPIC");
    expect(await readBill(db, card.company, billId)).toMatchObject({
      currency: "usd",
      amountUsdc: 20n * USDC,
      cardDeclinedAt: null,
    });
    const audit = (await auditOf("recurring_item", itemId)).at(-1);
    expect(audit).toMatchObject({
      before: { cardId: companyCard.cardId },
      after: {
        cardId: newCard.cardId,
        cardMerchants: { added: [added?.id], linked: [newCardsOwn] },
      },
    });
    const { released } = audit?.after?.cardMerchants as {
      released: string[];
    };
    expect([...released].sort()).toEqual(
      [moves, seenOnBoth, blockedHere].sort(),
    );
  });

  it("changes a card-paid estimate in USD only", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();

    // #when
    const inUsd = await patchItem(itemId, { amountUsd: "25" });
    const inKes = await patchItem(itemId, { amountKes: "3,000" });

    // #then
    expect(await dataOf(inUsd, recurringItemSchema)).toMatchObject({
      currency: "usd",
      amountUsdc: "25000000",
    });
    expect(inKes.status).toBe(400);
    expect((await errorOf(inKes)).message).toBe(
      "A payment by company-held card is estimated in USD. Enter the amount in USD.",
    );
    expect(await readBill(db, card.company, billId)).toMatchObject({
      amountUsdc: 20n * USDC,
    });
  });
});

describe("the bills of a recurring payment paid by a company-held card", () => {
  it("are never paid through Expendi, alone or with others", async () => {
    // #given a bill Expendi could pay, and a card-paid one
    const tillId = await insertPayee(db, card.company, {
      name: "Kenya Power",
      method: "mpesa_till",
      tillNumber: "123456",
      accountName: "Kenya Power",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payable = await insertBill(db, card.company, {
      payeeId: tillId,
      categoryId: card.categoryId,
      dueOn: today,
      status: "due",
    });
    const { billId } = await cardPaidItem();

    // #when
    const alone = await send("POST", "/bills/payment", { billIds: [billId] });
    const withOthers = await send("POST", "/bills/payment", {
      billIds: [payable, billId],
    });

    // #then
    for (const response of [alone, withOthers]) {
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toEqual({
        _tag: "Conflict",
        message: "This bill is paid automatically by card •••• 1881.",
        details: { billId, reason: "paid_by_card_recurring" },
      });
    }
    expect(await readBill(db, card.company, payable)).toMatchObject({
      status: "due",
      payoutId: null,
    });
  });

  it("can be marked paid outside, which forgets a decline and creates the next bill in USD", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({ cardDeclinedAt: new Date(), cardDeclineReason: "Frozen." })
        .where(eq(bills.id, billId)),
    );

    // #when
    const marked = await dataOf(
      await send("POST", `/bills/${billId}/mark-paid-outside`, {
        paidOn: today,
      }),
      billDetailSchema,
    );

    // #then
    expect(marked).toMatchObject({
      status: "paid_outside",
      cardDeclinedAt: null,
      cardDeclineReason: null,
      card: null,
    });
    const next = await openBillOf(itemId);
    expect(next).toMatchObject({
      dueOn: shiftDays(today, 10),
      currency: "usd",
      amountKes: null,
      amountUsdc: 20n * USDC,
      status: "upcoming",
    });
    expect((await auditOf("bill", billId)).at(-1)).toMatchObject({
      action: "bill.marked_paid_outside",
      before: { cardDeclineReason: "Frozen." },
      after: { cardDeclinedAt: null, status: "paid_outside" },
    });
  });

  it("can be cancelled, which creates the next bill", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();

    // #when
    const response = await send("POST", `/bills/${billId}/cancel`, {
      reason: "Cancelled the plan",
    });

    // #then
    expect(response.status).toBe(200);
    expect((await openBillOf(itemId)).id).not.toBe(billId);
  });

  it("forget the card's last decline when cancelled, as when marked paid", async () => {
    // #given
    const { billId } = await cardPaidItem();
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({ cardDeclinedAt: new Date(), cardDeclineReason: "Frozen." })
        .where(eq(bills.id, billId)),
    );

    // #when
    const cancelled = await dataOf(
      await send("POST", `/bills/${billId}/cancel`, {
        reason: "Cancelled the plan",
      }),
      billDetailSchema,
    );

    // #then
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cardDeclinedAt: null,
      cardDeclineReason: null,
    });
    expect((await auditOf("bill", billId)).at(-1)).toMatchObject({
      action: "bill.cancelled",
      before: { cardDeclineReason: "Frozen." },
      after: { cardDeclinedAt: null, status: "cancelled" },
    });
  });

  it("show the card's last decline on the payment's bill still owed", async () => {
    // #given
    const { itemId, billId } = await cardPaidItem();
    const declinedAt = new Date("2026-11-13T06:00:00Z");
    await runInScope(db, adminScope(), (tx) =>
      tx
        .update(bills)
        .set({ cardDeclinedAt: declinedAt, cardDeclineReason: "Frozen." })
        .where(eq(bills.id, billId)),
    );

    // #when
    const item = await dataOf(
      await send("GET", `/recurring-items/${itemId}`),
      recurringItemSchema,
    );
    const listed = await dataOf(
      await send("GET", "/recurring-items"),
      recurringItemsResponseSchema,
    );

    // #then
    expect(item.nextBill).toMatchObject({
      id: billId,
      cardDeclinedAt: declinedAt.toISOString(),
    });
    expect(
      listed.find((each) => each.id === itemId)?.nextBill?.cardDeclinedAt,
    ).toBe(declinedAt.toISOString());
  });

  it("take this cycle's estimate in USD, with a reason when it was fixed", async () => {
    // #given
    const { billId } = await cardPaidItem();

    // #when
    const inUsd = await send("PATCH", `/bills/${billId}`, {
      amountUsd: "24.50",
      adjustmentReason: "Extra seat this month",
    });
    const inKes = await send("PATCH", `/bills/${billId}`, {
      amountKes: "3,000",
      adjustmentReason: "Extra seat this month",
    });

    // #then
    expect(await dataOf(inUsd, billDetailSchema)).toMatchObject({
      currency: "usd",
      amountUsdc: "24500000",
      card: { id: companyCard.cardId, lastFour: "1881" },
    });
    expect(inKes.status).toBe(400);
    expect((await errorOf(inKes)).message).toBe(
      "A company-held card pays this bill, so enter its amount in USD.",
    );
  });

  it("count as still to pay, but not as waiting for an amount", async () => {
    // #given one card-paid bill with no estimate, one variable bill waiting
    await cardPaidItem({ amountUsdc: null });
    await insertBill(db, card.company, {
      payeeId: anthropicId,
      categoryId: card.categoryId,
      variable: true,
      amountKes: null,
      dueOn: today,
      status: "due",
    });

    // #when
    const summary = await dataOf(
      await send("GET", "/bills/summary"),
      billsSummarySchema,
    );

    // #then
    expect(summary).toMatchObject({
      views: { open: 2, paying: 0, history: 0 },
      toPay: { count: 2, withoutAmount: 1 },
    });
  });
});

describe("a bill paid by a Card purchase", () => {
  it("is settled: it can't be changed, paid, marked paid or cancelled", async () => {
    // #given
    const { billId } = await cardPaidItem();
    await payByCard(billId);

    // #when
    const responses = await Promise.all([
      send("PATCH", `/bills/${billId}`, { notes: "Seat added" }),
      send("POST", `/bills/${billId}/mark-paid-outside`, { paidOn: today }),
      send("POST", `/bills/${billId}/cancel`, { reason: "Not needed" }),
    ]);
    const pay = await send("POST", "/bills/payment", { billIds: [billId] });

    // #then
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toBe(
        "This bill was paid by card, so it can't be changed.",
      );
    }
    expect(pay.status).toBe(409);
    expect(await errorOf(pay)).toMatchObject({
      message: "This bill was already paid by card.",
      details: { billId, reason: "not_unpaid" },
    });
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "paid_by_card",
    });
  });

  it("sits in History with its card, not in To pay", async () => {
    // #given
    const { billId } = await cardPaidItem();
    const { purchaseId } = await payByCard(billId);

    // #when
    const open = await dataOf(
      await send("GET", "/bills?view=open"),
      billsResponseSchema,
    );
    const history = await dataOf(
      await send("GET", "/bills?view=history"),
      billsResponseSchema,
    );

    // #then
    expect(open.map((bill) => bill.id)).not.toContain(billId);
    expect(history.find((bill) => bill.id === billId)).toMatchObject({
      status: "paid_by_card",
      card: { id: companyCard.cardId, lastFour: "1881" },
      cardPurchaseId: purchaseId,
    });
  });

  it("has a payment receipt with the payee, USD and KES, the date and the card", async () => {
    // #given
    const { billId } = await cardPaidItem();
    const { purchaseId } = await payByCard(billId);

    // #when
    const data = await runtime.runPromise(
      getBillPaymentReceiptData(
        {
          organizationId: card.company.organizationId,
          userId: card.company.admin.id,
          membershipId: card.company.adminMembershipId,
          role: "admin",
        },
        billId,
      ),
    );
    const download = await send("GET", `/bills/${billId}/payment-receipt`);

    // #then
    expect(data).toMatchObject({
      payeeName: "Anthropic",
      amountKesCents: 277_000n,
      rate: "128.84",
      method: null,
      card: { lastFour: "1881", amountUsdCents: 2_150n },
      usdcSent: null,
    });
    expect(data.receiptNumber).toBe(
      `RCT-${purchaseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    );
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("an accountant", () => {
  it("reads a card-paid payment and its bill, and changes neither", async () => {
    // #given
    const accountant = await createUser(db);
    await addMember(db, card.company, accountant, { role: "accountant" });
    const { itemId, billId } = await cardPaidItem();

    // #when
    const item = await send(
      "GET",
      `/recurring-items/${itemId}`,
      undefined,
      accountant,
    );
    const bill = await send("GET", `/bills/${billId}`, undefined, accountant);
    const switching = await send(
      "PATCH",
      `/recurring-items/${itemId}`,
      { payVia: "outside" },
      accountant,
    );
    const marking = await send(
      "POST",
      `/bills/${billId}/mark-paid-outside`,
      { paidOn: today },
      accountant,
    );

    // #then
    expect(await dataOf(item, recurringItemSchema)).toMatchObject({
      card: { id: companyCard.cardId },
    });
    expect(await dataOf(bill, billDetailSchema)).toMatchObject({
      card: { id: companyCard.cardId },
    });
    expect(switching.status).toBe(403);
    expect(marking.status).toBe(403);
    expect(await readRecurringItem(db, card.company, itemId)).toMatchObject({
      payVia: "card",
    });
  });

  it("isn't shown another company's card-paid payment", async () => {
    // #given
    const { itemId } = await cardPaidItem();
    const other = await createCompany(db);

    // #when
    const response = await sendJson(
      app,
      `/organizations/${other.organizationId}/recurring-items/${itemId}`,
      other.admin,
      { method: "GET" },
    );

    // #then
    expect(response.status).toBe(404);
  });
});
