import type { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  billDetailSchema,
  billsResponseSchema,
  cardListSchema,
  cardProgramSchema,
  cardPurchaseListSchema,
  cardPurchaseSchema,
  expendiCardSchema,
  recurringItemSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { DbScope } from "../../db/scope.js";
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
  cardPurchases,
  cards,
  expenses,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  insertBill,
  insertBillPayment,
  insertPayee,
} from "../helpers/bills.js";
import {
  addCompanyHeldCard,
  authorize,
  cardExpensesOf,
  createCardCompany,
  readPurchaseByToken,
  sendLithicEvent,
  transactionEvent,
} from "../helpers/card-purchases.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createActiveWallet, createUser } from "../helpers/db.js";
import {
  fakeLithicTransaction,
  makeFakeLithic,
  makeFakePaycrest,
} from "../helpers/fakes.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const lithic = makeFakeLithic();
const paycrest = makeFakePaycrest();

let runtime: AppRuntime;
let db: Database;
let app: App;

beforeAll(async () => {
  runtime = makeTestRuntime({
    lithic: lithic.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

let card: CardCompany;
let companyCard: CompanyHeldCard;
let accountant: TestUser;

beforeEach(async () => {
  lithic.state.reset();
  paycrest.state.reset();
  card = await createCardCompany(db);
  companyCard = await addCompanyHeldCard(db, card.company, {
    defaultCategoryId: card.categoryId,
  });
  accountant = await createUser(db);
  await addMember(db, card.company, accountant, { role: "accountant" });
});

const orgPath = (rest: string) =>
  `/organizations/${card.company.organizationId}${rest}`;

async function dataOf<T extends z.ZodType>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { data } = (await response.json()) as { data: unknown };
  return schema.parse(data);
}

const get = (user: Pick<TestUser, "privyUserId">, path: string) =>
  sendJson(app, orgPath(path), user, { method: "GET" });

const inCompany = (scope: Omit<DbScope, "organizationId"> = {}) => ({
  organizationId: card.company.organizationId,
  ...scope,
});

/** A payee with a USD recurring payment the company-held card pays. */
async function cardPaidItem(
  cardId: string = companyCard.cardId,
): Promise<{ readonly itemId: string; readonly payeeId: string }> {
  const payeeId = await insertPayee(db, card.company, {
    kind: "vendor",
    name: "Anthropic",
  });
  const itemId = await insertRecurringItem(db, card.company, {
    payeeId,
    categoryId: card.categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: 20_000_000n,
    payVia: "card",
    cardId,
  });
  return { itemId, payeeId };
}

describe("a company-held card", () => {
  it("has no cardholder, and every other card has one", async () => {
    // #given
    const withHolder = addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      membershipId: card.holderMembershipId,
    });
    const withoutHolder = addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      companyHeld: false,
    });

    // #then
    await expect(withHolder).rejects.toMatchObject({
      cause: { constraint: "cards_holder_unless_company_held" },
    });
    await expect(withoutHolder).rejects.toMatchObject({
      cause: { constraint: "cards_holder_unless_company_held" },
    });
  });

  it("shows admins and accountants a card nobody holds, with what it pays", async () => {
    // #given
    const { itemId } = await cardPaidItem();

    // #when
    const forAdmin = await dataOf(
      await get(card.company.admin, `/cards/${companyCard.cardId}`),
      expendiCardSchema,
    );
    const forAccountant = await dataOf(
      await get(accountant, "/cards?companyHeld=true"),
      cardListSchema,
    );

    // #then
    expect(forAdmin).toMatchObject({
      id: companyCard.cardId,
      companyHeld: true,
      holder: null,
      yours: false,
      recurringPayments: [
        { id: itemId, payeeName: "Anthropic", state: "active" },
      ],
    });
    expect(forAccountant.cards.map((each) => each.id)).toEqual([
      companyCard.cardId,
    ]);
  });

  it("keeps a person's card as it was", async () => {
    // #when
    const personal = await dataOf(
      await get(card.holder, `/cards/${card.cardId}`),
      expendiCardSchema,
    );

    // #then
    expect(personal).toMatchObject({
      companyHeld: false,
      holder: { membershipId: card.holderMembershipId },
      yours: true,
      recurringPayments: [],
    });
  });

  it("is never shown to an employee, nor are its purchases", async () => {
    // #given
    const token = randomUUID();
    await authorize(app, companyCard.cardToken, token, 2000);
    const purchase = await readPurchaseByToken(db, card.company, token);
    if (!purchase) throw new Error("purchase not recorded");

    // #when
    const cardList = await dataOf(
      await get(card.holder, "/cards"),
      cardListSchema,
    );
    const purchaseList = await dataOf(
      await get(card.holder, "/cards/purchases"),
      cardPurchaseListSchema,
    );
    const oneCard = await get(card.holder, `/cards/${companyCard.cardId}`);
    const onePurchase = await get(
      card.holder,
      `/cards/purchases/${purchase.id}`,
    );
    const companyHeldRows = await runInScope(
      db,
      inCompany({ role: "employee", userId: card.holder.id }),
      (tx) => tx.select().from(cards).where(eq(cards.companyHeld, true)),
    );

    // #then
    expect(cardList.cards.map((each) => each.id)).toEqual([card.cardId]);
    expect(purchaseList.purchases).toEqual([]);
    expect([oneCard.status, onePurchase.status]).toEqual([404, 404]);
    expect(companyHeldRows).toEqual([]);
  });

  it("still counts its purchases in the Card balance an employee sees", async () => {
    // #given
    await authorize(app, companyCard.cardToken, randomUUID(), 2000);

    // #when
    const program = await dataOf(
      await get(card.holder, "/cards/program"),
      cardProgramSchema,
    );

    // #then
    expect(program).toMatchObject({
      status: "on",
      balance: { onHoldUsdCents: "2000", availableUsdCents: "98000" },
    });
  });

  it("shows admins its purchases with no holder, keyed by merchant, unmatched until its transaction arrives", async () => {
    // #given
    const token = randomUUID();
    await authorize(app, companyCard.cardToken, token, 2000);
    const purchase = await readPurchaseByToken(db, card.company, token);

    // #when
    const view = await dataOf(
      await get(card.company.admin, `/cards/purchases/${purchase?.id ?? ""}`),
      cardPurchaseSchema,
    );

    // #then
    expect(view).toMatchObject({
      companyHeld: true,
      holder: null,
      yours: false,
      merchantKey: "name:ACME SOFTWARE",
      match: null,
    });
  });

  it("records a settled purchase's Card expense under the admin who issued the card", async () => {
    // #given
    const token = randomUUID();
    await authorize(app, companyCard.cardToken, token, 2500);
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: companyCard.cardToken,
        status: "SETTLED",
        settlement: -2500,
      }),
    );

    // #when
    const response = await sendLithicEvent(app, transactionEvent(token));

    // #then
    expect(response.status).toBe(200);
    expect(await cardExpensesOf(db, card.company)).toMatchObject([
      { membershipId: card.company.adminMembershipId, billId: null },
    ]);
  });

  it("isn't closed when the admin who issued it leaves", async () => {
    // #given
    const issuer = await createUser(db);
    const issuerMembershipId = await addMember(db, card.company, issuer, {
      role: "admin",
    });
    const issued = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
      issuedBy: issuer.id,
    });

    // #when
    const removal = await sendJson(
      app,
      orgPath(`/members/${issuerMembershipId}`),
      card.company.admin,
      { method: "DELETE" },
    );

    // #then
    expect(removal.status).toBe(200);
    const [row] = await runInScope(db, inCompany(), (tx) =>
      tx.select().from(cards).where(eq(cards.id, issued.cardId)),
    );
    expect(row).toMatchObject({ state: "open", closeRequestedAt: null });
  });
});

describe("a recurring payment paid by a company-held card", () => {
  const item = async (values: Parameters<typeof insertRecurringItem>[2]) =>
    insertRecurringItem(db, card.company, values);

  it("names its card exactly when it's paid by card, in USD", async () => {
    // #given
    const payeeId = await insertPayee(db, card.company);
    const base = {
      payeeId,
      categoryId: card.categoryId,
      currency: "usd" as const,
      amountKes: null,
      amountUsdc: 20_000_000n,
    };

    // #then
    await expect(item({ ...base, payVia: "card" })).rejects.toMatchObject({
      cause: { constraint: "recurring_items_card_pays_by_card" },
    });
    await expect(
      item({ ...base, payVia: "outside", cardId: companyCard.cardId }),
    ).rejects.toMatchObject({
      cause: { constraint: "recurring_items_card_pays_by_card" },
    });
    await expect(
      item({
        ...base,
        currency: "kes",
        amountKes: 250_000n,
        amountUsdc: null,
        payVia: "card",
        cardId: companyCard.cardId,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "recurring_items_card_in_usd" },
    });
  });

  it("shows the card that pays it", async () => {
    // #given
    const { itemId } = await cardPaidItem();

    // #when
    const view = await dataOf(
      await get(card.company.admin, `/recurring-items/${itemId}`),
      recurringItemSchema,
    );

    // #then
    expect(view).toMatchObject({
      payVia: "card",
      card: {
        id: companyCard.cardId,
        nickname: "Software subscriptions",
        lastFour: "1881",
        state: "open",
      },
    });
  });
});

describe("a bill paid by card", () => {
  async function settledPurchase(itemId: string): Promise<string> {
    const [purchase] = await runInScope(
      db,
      inCompany({ role: "admin" }),
      (tx) =>
        tx
          .insert(cardPurchases)
          .values({
            organizationId: card.company.organizationId,
            cardId: companyCard.cardId,
            membershipId: null,
            lithicTransactionToken: randomUUID(),
            status: "settled",
            merchant: "ANTHROPIC",
            merchantKey: "merchant-anthropic",
            mcc: "5734",
            settledUsdCents: 2_150n,
            authorizedAt: new Date(),
            categoryId: card.categoryId,
            recurringItemId: itemId,
          })
          .returning({ id: cardPurchases.id }),
    );
    if (!purchase) throw new Error("purchase insert returned no row");
    return purchase.id;
  }

  const billValues = (payeeId: string, itemId: string) => ({
    payeeId,
    categoryId: card.categoryId,
    recurringItemId: itemId,
    overviewHeading: "subscriptions" as const,
    currency: "usd" as const,
    amountKes: null,
    amountUsdc: 21_500_000n,
  });

  it("is paid_by_card exactly when a Card purchase paid it", async () => {
    // #given
    const { itemId, payeeId } = await cardPaidItem();
    const purchaseId = await settledPurchase(itemId);
    const paid = {
      status: "paid_by_card" as const,
      paidOn: "2026-11-13",
      paidAt: new Date(),
    };

    // #then
    await expect(
      insertBill(db, card.company, { ...billValues(payeeId, itemId), ...paid }),
    ).rejects.toMatchObject({
      cause: { constraint: "bills_paid_by_card_has_purchase" },
    });
    await expect(
      insertBill(db, card.company, {
        ...billValues(payeeId, itemId),
        status: "due",
        cardPurchaseId: purchaseId,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "bills_paid_by_card_has_purchase" },
    });
    await expect(
      insertBill(db, card.company, {
        ...billValues(payeeId, itemId),
        status: "paid_by_card",
        cardPurchaseId: purchaseId,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "bills_paid_has_dates" },
    });
  });

  it("shows the card and the purchase that paid it, and the purchase shows the bill", async () => {
    // #given
    const { itemId, payeeId } = await cardPaidItem();
    const purchaseId = await settledPurchase(itemId);
    const billId = await insertBill(db, card.company, {
      ...billValues(payeeId, itemId),
      status: "paid_by_card",
      paidOn: "2026-11-13",
      paidAt: new Date(),
      cardPurchaseId: purchaseId,
    });
    await runInScope(db, inCompany({ role: "admin" }), async (tx) => {
      await tx
        .update(cardPurchases)
        .set({ billId })
        .where(eq(cardPurchases.id, purchaseId));
      // The bill's spending row: a Card purchase that pays a bill records it
      // as kind `card` with the bill.
      await tx.insert(expenses).values({
        organizationId: card.company.organizationId,
        membershipId: card.company.adminMembershipId,
        kind: "card",
        status: "recorded",
        overviewHeading: "subscriptions",
        paidFromAccountId: card.accountId,
        billId,
        categoryId: card.categoryId,
        merchant: "ANTHROPIC",
        amountKes: 277_000n,
        spentOn: "2026-11-13",
      });
    });

    // #when
    const bill = await dataOf(
      await get(card.company.admin, `/bills/${billId}`),
      billDetailSchema,
    );
    const purchase = await dataOf(
      await get(card.company.admin, `/cards/purchases/${purchaseId}`),
      cardPurchaseSchema,
    );

    // #then
    expect(bill).toMatchObject({
      status: "paid_by_card",
      card: { id: companyCard.cardId, lastFour: "1881", state: "open" },
      cardPurchaseId: purchaseId,
      cardDeclinedAt: null,
      markedPaidBy: null,
      payoutId: null,
      paidAmountKes: "277000",
    });
    expect(purchase.match).toEqual({
      state: "matched",
      recurringItemId: itemId,
      billId,
      payeeName: "Anthropic",
    });
  });

  it("shows the card that will pay a bill still owed, and why it last declined", async () => {
    // #given
    const { itemId, payeeId } = await cardPaidItem();
    const declinedAt = new Date("2026-11-13T06:00:00Z");
    const billId = await insertBill(db, card.company, {
      ...billValues(payeeId, itemId),
      status: "due",
      cardDeclinedAt: declinedAt,
      cardDeclineReason: "There isn't enough in the Card balance.",
    });

    // #when
    const bill = await dataOf(
      await get(card.company.admin, `/bills/${billId}`),
      billDetailSchema,
    );

    // #then
    expect(bill).toMatchObject({
      card: { id: companyCard.cardId, nickname: "Software subscriptions" },
      cardDeclinedAt: declinedAt.toISOString(),
      cardDeclineReason: "There isn't enough in the Card balance.",
      cardPurchaseId: null,
    });
  });

  it("says when the card that will pay it is frozen, and what's owed has no KES paid yet", async () => {
    // #given
    const { itemId, payeeId } = await cardPaidItem();
    const billId = await insertBill(db, card.company, {
      ...billValues(payeeId, itemId),
      status: "due",
    });
    await runInScope(db, inCompany({ role: "admin" }), (tx) =>
      tx
        .update(cards)
        .set({ state: "frozen" })
        .where(eq(cards.id, companyCard.cardId)),
    );

    // #when
    const detail = await dataOf(
      await get(card.company.admin, `/bills/${billId}`),
      billDetailSchema,
    );
    const listed = await dataOf(
      await get(card.company.admin, "/bills"),
      billsResponseSchema,
    );

    // #then
    expect(detail.card?.state).toBe("frozen");
    expect(detail.paidAmountKes).toBeNull();
    expect(listed.find((each) => each.id === billId)?.card?.state).toBe(
      "frozen",
    );
  });

  it("says whether its recurring payment is paused once it has ended, as the card pays its last bill only if not", async () => {
    // #given a schedule that ended with this, its last bill, still owed
    const { itemId, payeeId } = await cardPaidItem();
    const asAdmin = inCompany({ role: "admin" });
    await runInScope(db, asAdmin, (tx) =>
      tx
        .update(recurringItems)
        .set({ nextDueOn: null })
        .where(eq(recurringItems.id, itemId)),
    );
    const billId = await insertBill(db, card.company, {
      ...billValues(payeeId, itemId),
      status: "due",
    });
    const read = async () => ({
      detail: await dataOf(
        await get(card.company.admin, `/bills/${billId}`),
        billDetailSchema,
      ),
      listed: (
        await dataOf(
          await get(card.company.admin, "/bills"),
          billsResponseSchema,
        )
      ).find((each) => each.id === billId),
    });

    // #when it's read, then paused and read again
    const running = await read();
    await runInScope(db, asAdmin, (tx) =>
      tx
        .update(recurringItems)
        .set({ active: false })
        .where(eq(recurringItems.id, itemId)),
    );
    const paused = await read();

    // #then
    for (const [{ detail, listed }, active] of [
      [running, true],
      [paused, false],
    ] as const) {
      expect(detail.recurring).toMatchObject({ state: "ended", active });
      expect(listed?.recurring).toMatchObject({ state: "ended", active });
    }
  });

  it("comes to the KES its payouts delivered when paid through Expendi", async () => {
    // #given
    const payeeId = await insertPayee(db, card.company, {
      name: "Kenya Power",
    });
    const billId = await insertBill(db, card.company, {
      payeeId,
      categoryId: card.categoryId,
      status: "due",
    });
    const wallet = await createActiveWallet(db, card.company);
    await insertBillPayment(db, card.company, wallet.id, billId, {
      amountKes: 250_100n,
    });

    // #when
    const bill = await dataOf(
      await get(card.company.admin, `/bills/${billId}`),
      billDetailSchema,
    );

    // #then
    expect(bill).toMatchObject({ status: "paid", paidAmountKes: "250100" });
  });

  it("names no card once it's settled some other way", async () => {
    // #given
    const { itemId, payeeId } = await cardPaidItem();
    const billId = await insertBill(db, card.company, {
      ...billValues(payeeId, itemId),
      status: "cancelled",
      cancelledReason: "Stopped using it",
      cancelledBy: card.company.admin.id,
      cancelledAt: new Date(),
    });

    // #when
    const bill = await dataOf(
      await get(card.company.admin, `/bills/${billId}`),
      billDetailSchema,
    );

    // #then
    expect(bill.card).toBeNull();
    const [row] = await runInScope(db, inCompany({ role: "admin" }), (tx) =>
      tx.select().from(bills).where(eq(bills.id, billId)),
    );
    expect(row?.cardPurchaseId).toBeNull();
  });
});
