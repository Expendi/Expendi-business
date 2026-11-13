import type { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ReviewCardPurchaseRequest } from "@expendi-business/shared";
import {
  cardPurchaseListSchema,
  cardPurchaseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { BillRow } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  CardCompany,
  CompanyHeldCard,
} from "../helpers/card-purchases.js";
import type { TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  cardMerchants,
  cardPurchases,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { EXTRA_CARD_PURCHASE_NOTE } from "../../services/bills/card-payment.js";
import { runCardReceiptReminders } from "../../services/cards/reminders.js";
import { notify } from "../../services/notification/notify.js";
import { insertBill, insertPayee, readBill } from "../helpers/bills.js";
import {
  accountingSyncsOf,
  addCompanyHeldCard,
  authorize,
  cardExpensesOf,
  connectAccounting,
  createCardCompany,
  outboxOf,
  readPurchaseByToken,
  sendLithicEvent,
  transactionEvent,
} from "../helpers/card-purchases.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  fakeLithicTransaction,
  makeFakeLithic,
  makeFakePaycrest,
} from "../helpers/fakes.js";
import {
  billsOfItem,
  insertRecurringItem,
  outstandingBillsOfItem,
  readRecurringItem,
} from "../helpers/recurring.js";
import { barrier, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const lithic = makeFakeLithic();
const paycrest = makeFakePaycrest();

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({
    lithic: lithic.layer,
    paycrest: paycrest.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

let card: CardCompany;
let companyCard: CompanyHeldCard;

beforeEach(async () => {
  lithic.state.reset();
  paycrest.state.reset();
  card = await createCardCompany(db);
  companyCard = await addCompanyHeldCard(db, card.company, {
    defaultCategoryId: card.categoryId,
  });
});

/** The day the fake Lithic's transactions settle on, in Nairobi. */
const SETTLED_ON = "2026-11-08";
const USDC_PER_CENT = 10_000n;
const ANTHROPIC = "acceptor-anthropic";
const VERCEL = "acceptor-vercel";

const asAdmin = () => ({
  organizationId: card.company.organizationId,
  userId: card.company.admin.id,
  role: "admin" as const,
});

interface CardPaidItem {
  readonly itemId: string;
  readonly payeeId: string;
}

/**
 * A USD recurring payment the company-held card pays, monthly, with an
 * estimate (none when `estimateCents` is null) and no bill yet.
 */
async function cardPaidItem({
  payeeName = "Anthropic",
  estimateCents = 2_000n,
  nextDueOn = "2026-12-11",
  endsOn = null,
  cardId = companyCard.cardId,
}: {
  readonly payeeName?: string;
  readonly estimateCents?: bigint | null;
  readonly nextDueOn?: string | null;
  readonly endsOn?: string | null;
  readonly cardId?: string;
} = {}): Promise<CardPaidItem> {
  const payeeId = await insertPayee(db, card.company, {
    kind: "vendor",
    name: payeeName,
  });
  const itemId = await insertRecurringItem(db, card.company, {
    payeeId,
    categoryId: card.categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: estimateCents === null ? null : estimateCents * USDC_PER_CENT,
    scheduleDay: 11,
    nextDueOn,
    endsOn,
    payVia: "card",
    cardId,
  });
  return { itemId, payeeId };
}

/**
 * A monthly payment whose schedule ended on 2026-11-11: creating that day's
 * bill, its last, left `next_due_on` null, and the bill is still owed.
 */
async function lastBillOwed(
  values: { payeeName?: string } = {},
): Promise<CardPaidItem & { readonly billId: string }> {
  const item = await cardPaidItem({
    ...values,
    nextDueOn: null,
    endsOn: "2026-11-11",
  });
  return { ...item, billId: await openBill(item) };
}

/** The payment's open bill, as the schedule left it. */
function openBill(
  { itemId, payeeId }: CardPaidItem,
  values: Partial<BillRow> = {},
): Promise<string> {
  return insertBill(db, card.company, {
    payeeId,
    categoryId: card.categoryId,
    recurringItemId: itemId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: 2_000n * USDC_PER_CENT,
    dueOn: "2026-11-11",
    status: "upcoming",
    ...values,
  });
}

/** A merchant the card already knows, as an admin's answer left it. */
async function knownMerchant(
  merchantKey: string,
  values: { recurringItemId?: string | null; blocked?: boolean } = {},
): Promise<void> {
  await runInScope(db, asAdmin(), (tx) =>
    tx.insert(cardMerchants).values({
      organizationId: card.company.organizationId,
      cardId: companyCard.cardId,
      merchantKey,
      descriptor: merchantKey.toUpperCase(),
      ...values,
    }),
  );
}

type TransactionFields = Parameters<typeof fakeLithicTransaction>[0];

/** Puts the transaction at Lithic for the company-held card and delivers an event. */
function deliver(
  token: string,
  fields: Omit<TransactionFields, "token" | "cardToken">,
) {
  lithic.state.transactions.set(
    token,
    fakeLithicTransaction({
      token,
      cardToken: companyCard.cardToken,
      ...fields,
    }),
  );
  return sendLithicEvent(app, transactionEvent(token));
}

/** A settled Card purchase of `cents` from `acceptorId`, delivered once. */
async function settle(
  cents: number,
  acceptorId = ANTHROPIC,
  token: string = randomUUID(),
): Promise<string> {
  const response = await deliver(token, {
    status: "SETTLED",
    settlement: -cents,
    acceptorId,
    merchant: acceptorId.replace("acceptor-", "").toUpperCase(),
    events: ["AUTHORIZATION", "CLEARING"],
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return token;
}

async function purchaseOf(token: string) {
  const purchase = await readPurchaseByToken(db, card.company, token);
  if (!purchase) throw new Error(`no purchase for ${token}`);
  return purchase;
}

const purchasesPath = (rest = "") =>
  `/organizations/${card.company.organizationId}/cards/purchases${rest}`;

async function dataOf<T extends z.ZodType>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { data } = (await response.json()) as { data: unknown };
  return schema.parse(data);
}

function review(
  purchaseId: string,
  body: ReviewCardPurchaseRequest,
  user: Pick<TestUser, "privyUserId"> = card.company.admin,
) {
  return sendJson(app, purchasesPath(`/${purchaseId}/review`), user, {
    method: "POST",
    body,
  });
}

async function errorOf(response: Response): Promise<string> {
  const { error } = (await response.clone().json()) as {
    error: { message: string };
  };
  return error.message;
}

const auditActions = async (entityId: string) => {
  const { rows } = await owner.query<{ action: string; after: unknown }>(
    "SELECT action, after FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id",
    [entityId],
  );
  return rows;
};

const merchantsOfCard = () =>
  runInScope(db, asAdmin(), (tx) =>
    tx
      .select()
      .from(cardMerchants)
      .where(eq(cardMerchants.cardId, companyCard.cardId)),
  );

/** Until a session waits on `pid`, `orUntil` settles, or a few seconds pass. */
async function waitUntilBlockedBy(
  pid: number,
  orUntil: Promise<unknown> = new Promise<never>(() => undefined),
): Promise<void> {
  const settled = orUntil.then(
    () => true,
    () => true,
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await owner.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    const pause = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        resolve(false);
      }, 50),
    );
    if (await Promise.race([settled, pause])) return;
  }
}

class RolledBack extends Error {}

/**
 * Another session registering `merchantKey` with the card, uncommitted, so
 * a purchase registering the same merchant waits on it until `rollBack`.
 */
async function registeringMerchant(merchantKey: string): Promise<{
  readonly pid: number;
  readonly rollBack: () => Promise<void>;
}> {
  let rollBack = (): void => undefined;
  const rolledBack = new Promise<void>((resolve) => {
    rollBack = resolve;
  });
  let started = (_pid: number): void => undefined;
  const registered = new Promise<number>((resolve) => {
    started = resolve;
  });
  const session = runInScope(db, asAdmin(), async (tx) => {
    await tx.insert(cardMerchants).values({
      organizationId: card.company.organizationId,
      cardId: companyCard.cardId,
      merchantKey,
      descriptor: merchantKey.toUpperCase(),
    });
    const { rows } = await tx.execute<{ pid: number }>(
      sql`SELECT pg_backend_pid() AS pid`,
    );
    started(rows[0]?.pid ?? 0);
    await rolledBack;
    throw new RolledBack();
  }).catch((error: unknown) => {
    if (!(error instanceof RolledBack)) throw error;
  });
  return {
    pid: await Promise.race([
      registered,
      session.then(() =>
        Promise.reject(new Error("the session ended before registering")),
      ),
    ]),
    rollBack: async () => {
      rollBack();
      await session;
    },
  };
}

/** Until `sessions` wait for a `card_merchants` row, or a few seconds pass. */
async function waitForMerchantWaiters(sessions: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await owner.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'tuple' AND relation = 'card_merchants'::regclass",
    );
    if ((rows[0]?.waiting ?? 0) >= sessions) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs `work` while another transaction holds the card's row for
 * `merchantKey`, and lets it go once `sessions` queue for it, so they reach
 * the merchant together.
 */
async function whileMerchantHeld<T>(
  merchantKey: string,
  sessions: number,
  work: () => Promise<T>,
): Promise<T> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = (): void => undefined;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = runInScope(db, asAdmin(), async (tx) => {
    await tx
      .select({ id: cardMerchants.id })
      .from(cardMerchants)
      .where(
        and(
          eq(cardMerchants.cardId, companyCard.cardId),
          eq(cardMerchants.merchantKey, merchantKey),
        ),
      )
      .for("update");
    held();
    await released;
  });
  await holding;
  const working = work();
  await waitForMerchantWaiters(sessions);
  release();
  await holder;
  return working;
}

describe("matching a company-held card's purchase by merchant", () => {
  it("links the first merchant on a card that pays one thing, and pays its bill with the actual amount", async () => {
    // #given an estimate of USD 20.00 and a bill due in 3 days
    await connectAccounting(db, card.company);
    const item = await cardPaidItem();
    const billId = await openBill(item);

    // #when USD 21.50 settles
    const token = await settle(2_150);

    // #then
    const purchase = await purchaseOf(token);
    expect(purchase).toMatchObject({
      merchantKey: ANTHROPIC,
      recurringItemId: item.itemId,
      billId,
      reviewState: null,
      usdKesRate: "128.68",
    });
    const bill = await readBill(db, card.company, billId);
    expect(bill).toMatchObject({
      status: "paid_by_card",
      currency: "usd",
      amountUsdc: 21_500_000n,
      amountKes: null,
      variable: false,
      paidOn: SETTLED_ON,
      cardPurchaseId: purchase.id,
      cardDeclinedAt: null,
    });
    expect(bill.paidAt).toBeInstanceOf(Date);
    expect(await cardExpensesOf(db, card.company)).toEqual([
      expect.objectContaining({
        id: purchase.expenseId,
        kind: "card",
        status: "recorded",
        source: "app",
        billId,
        overviewHeading: "subscriptions",
        categoryId: card.categoryId,
        merchant: "Anthropic",
        membershipId: card.company.adminMembershipId,
        paidFromAccountId: card.accountId,
        amountKes: 276_662n,
        spentOn: SETTLED_ON,
        description: "Expendi card Software subscriptions, ending 1881",
      }),
    ]);
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({
        merchantKey: ANTHROPIC,
        recurringItemId: item.itemId,
        blocked: false,
      }),
    ]);
    // The bill, not its spending row, goes to Zoho.
    expect(
      (await accountingSyncsOf(db, card.company)).map(
        ({ subjectType, subjectId }) => [subjectType, subjectId],
      ),
    ).toEqual([["bill", billId]]);
    expect((await auditActions(billId)).map((entry) => entry.action)).toContain(
      "bill.paid_by_card",
    );
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual([]);
  });

  it("creates the next bill, as any paid bill does", async () => {
    // #given
    const item = await cardPaidItem({ nextDueOn: "2026-12-11" });
    await openBill(item);

    // #when
    await settle(2_000);

    // #then
    const outstanding = await outstandingBillsOfItem(
      db,
      card.company,
      item.itemId,
    );
    expect(outstanding.map((bill) => [bill.dueOn, bill.amountUsdc])).toEqual([
      ["2026-12-11", 20_000_000n],
    ]);
    expect(
      (await readRecurringItem(db, card.company, item.itemId)).nextDueOn,
    ).toBe("2027-01-11");
  });

  it("asks admins once about a new merchant on a card that pays several things", async () => {
    // #given
    await cardPaidItem();
    await cardPaidItem({ payeeName: "Vercel" });
    const token = randomUUID();

    // #when it's held, then settles, then a second purchase from it arrives
    await authorize(app, companyCard.cardToken, token, 1_000, {
      acceptorId: ANTHROPIC,
      descriptor: "ANTHROPIC",
    });
    await deliver(token, {
      hold: -1_000,
      acceptorId: ANTHROPIC,
      merchant: "ANTHROPIC",
    });
    await settle(1_000, ANTHROPIC, token);
    const second = await settle(1_200);

    // #then
    for (const each of [token, second]) {
      expect(await purchaseOf(each)).toMatchObject({
        reviewState: "needs_review",
        recurringItemId: null,
        billId: null,
      });
    }
    const asked = await outboxOf(
      db,
      card.company,
      "card_purchase_needs_review",
    );
    expect(asked.map((row) => row.channel).sort()).toEqual(["email", "push"]);
    expect(asked[0]?.body).toBe(
      'A purchase on Software subscriptions needs an answer: is "ANTHROPIC" one of its recurring payments?',
    );
    // Until it's answered, each is an ordinary Card expense, with no receipt
    // asked for: it may yet pay a bill.
    expect(
      (await cardExpensesOf(db, card.company)).map((each) => each.billId),
    ).toEqual([null, null]);
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual([]);
  });

  it("prints a merchant's descriptor quoted, short and plain in what admins are told", async () => {
    // #given
    await cardPaidItem();
    await cardPaidItem({ payeeName: "Vercel" });
    const token = randomUUID();

    // #when the merchant names itself with a link and markup
    await deliver(token, {
      status: "SETTLED",
      settlement: -1_000,
      acceptorId: "acceptor-sly",
      merchant: "Pay now: https://evil.example/login?x=<1>\n  Fake & Co' #9",
    });

    // #then
    const [asked] = await outboxOf(
      db,
      card.company,
      "card_purchase_needs_review",
    );
    expect(asked?.body).toBe(
      'A purchase on Software subscriptions needs an answer: is "Pay now https evil. example loginx1 Fake" one of its recurring payments?',
    );
  });

  it("asks about a second merchant on a card that pays one thing", async () => {
    // #given
    await cardPaidItem();
    await settle(2_000, ANTHROPIC);

    // #when
    const other = await settle(500, VERCEL);

    // #then
    expect(await purchaseOf(other)).toMatchObject({
      reviewState: "needs_review",
      recurringItemId: null,
    });
  });

  it("keys a merchant by name when Lithic sends no ID", async () => {
    // #given
    await cardPaidItem();
    const token = randomUUID();

    // #when
    await deliver(token, {
      status: "SETTLED",
      settlement: -2_000,
      merchant: "  claude.ai subscription ",
    });

    // #then
    expect(await purchaseOf(token)).toMatchObject({
      merchantKey: "name:CLAUDE.AI SUBSCRIPTION",
    });
  });

  it("leaves a refund alone", async () => {
    // #given
    const item = await cardPaidItem();
    const billId = await openBill(item);
    const token = randomUUID();

    // #when
    await deliver(token, {
      status: "SETTLED",
      settlement: 1_500,
      acceptorId: ANTHROPIC,
      events: ["RETURN"],
    });

    // #then
    expect(await purchaseOf(token)).toMatchObject({
      kind: "refund",
      recurringItemId: null,
      reviewState: null,
      billId: null,
    });
    expect(await merchantsOfCard()).toEqual([]);
    expect((await readBill(db, card.company, billId)).status).toBe("upcoming");
  });

  it("never gives a one-payment card's link to a merchant it declined, or to the purchase check", async () => {
    // #given
    const item = await cardPaidItem();
    const billId = await openBill(item);
    const stranger = randomUUID();

    // #when a stranger is declined, then asks the purchase check, then the
    // payment's merchant charges
    await deliver(stranger, {
      status: "DECLINED",
      result: "DECLINED",
      detailedResults: ["INSUFFICIENT_FUNDS"],
      acceptorId: "acceptor-stranger",
    });
    await authorize(app, companyCard.cardToken, randomUUID(), 500, {
      acceptorId: "acceptor-stranger",
    });
    const merchantsAfterCheck = await merchantsOfCard();
    const token = await settle(2_000);

    // #then
    expect(await purchaseOf(stranger)).toMatchObject({
      recurringItemId: null,
      reviewState: null,
    });
    expect(merchantsAfterCheck).toEqual([]);
    expect(await purchaseOf(token)).toMatchObject({
      recurringItemId: item.itemId,
      billId,
    });
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({
        merchantKey: ANTHROPIC,
        recurringItemId: item.itemId,
      }),
    ]);
  });

  it("asks admins about a merchant the card knows but that pays nothing, when nothing of it is waiting", async () => {
    // #given a merchant left linked to nothing, e.g. by a payment that moved
    await cardPaidItem();
    await knownMerchant(VERCEL);

    // #when two purchases arrive from it
    const first = await settle(500, VERCEL);
    const second = await settle(700, VERCEL);

    // #then
    for (const token of [first, second]) {
      expect((await purchaseOf(token)).reviewState).toBe("needs_review");
    }
    const asked = await outboxOf(
      db,
      card.company,
      "card_purchase_needs_review",
    );
    expect(asked.map((row) => row.dedupeKey)).toEqual(
      Array(2).fill(
        `card_purchase_needs_review:${(await purchaseOf(first)).id}`,
      ),
    );
  });

  it("never lets a payment's merchant pay another payment's bill on the card it moved from", async () => {
    // #given the card pays X, whose merchant it knows, and Y, never charged
    const x = await cardPaidItem();
    await knownMerchant(ANTHROPIC, { recurringItemId: x.itemId });
    const y = await cardPaidItem({ payeeName: "Vercel" });
    const yBill = await openBill(y);
    const otherCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
    });

    // #when X moves to the other card, and its merchant charges this one
    const moved = await sendJson(
      app,
      `/organizations/${card.company.organizationId}/recurring-items/${x.itemId}`,
      card.company.admin,
      { method: "PATCH", body: { payVia: "card", cardId: otherCard.cardId } },
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    const purchase = await purchaseOf(await settle(2_000));

    // #then
    expect(purchase).toMatchObject({
      recurringItemId: null,
      billId: null,
      reviewState: "needs_review",
    });
    expect(await readBill(db, card.company, yBill)).toMatchObject({
      status: "upcoming",
      cardPurchaseId: null,
    });
    expect(
      (await outboxOf(db, card.company, "card_purchase_needs_review")).map(
        (row) => row.dedupeKey,
      ),
    ).toContain(`card_purchase_needs_review:${purchase.id}`);
  });

  it("never links a card's first merchant to the payment moving off the card as it's charged", async () => {
    // #given the card pays only Anthropic, and its first purchase is about
    // to register its merchant, having seen that
    const item = await cardPaidItem();
    const otherCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
    });
    const registering = await registeringMerchant(ANTHROPIC);
    const charged = settle(2_000);
    await waitUntilBlockedBy(registering.pid);
    const { rows } = await owner.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [registering.pid],
    );
    const purchasePid = rows[0]?.pid ?? 0;

    // #when Anthropic moves to the other card meanwhile
    const moving = sendJson(
      app,
      `/organizations/${card.company.organizationId}/recurring-items/${item.itemId}`,
      card.company.admin,
      { method: "PATCH", body: { payVia: "card", cardId: otherCard.cardId } },
    );
    await waitUntilBlockedBy(purchasePid, moving);
    await registering.rollBack();
    const [moved] = await Promise.all([moving, charged]);
    const next = await purchaseOf(await settle(2_100));

    // #then this card's row for it pays nothing, so nor does its next purchase
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({
        merchantKey: ANTHROPIC,
        recurringItemId: null,
      }),
    ]);
    expect(next).toMatchObject({
      recurringItemId: null,
      reviewState: "needs_review",
    });
  });

  it("never touches a person's card", async () => {
    // #given
    await cardPaidItem();
    const token = randomUUID();

    // #when
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: card.cardToken,
        status: "SETTLED",
        settlement: -2_000,
        acceptorId: ANTHROPIC,
      }),
    );
    await sendLithicEvent(app, transactionEvent(token));

    // #then
    expect(await purchaseOf(token)).toMatchObject({
      merchantKey: null,
      recurringItemId: null,
      reviewState: null,
    });
    expect(await merchantsOfCard()).toEqual([]);
  });
});

describe("which bill a Card purchase pays", () => {
  it("pays an overdue bill", async () => {
    // #given
    const item = await cardPaidItem();
    const billId = await openBill(item, {
      dueOn: "2026-10-11",
      status: "overdue",
    });

    // #when
    await settle(2_000);

    // #then
    expect((await readBill(db, card.company, billId)).status).toBe(
      "paid_by_card",
    );
  });

  it("records a purchase 20 days early as an extra bill, and leaves the schedule alone", async () => {
    // #given
    const item = await cardPaidItem({ nextDueOn: "2026-12-28" });
    const openId = await openBill(item, { dueOn: "2026-11-28" });

    // #when
    const token = await settle(2_000);

    // #then
    const purchase = await purchaseOf(token);
    const bills = await billsOfItem(db, card.company, item.itemId);
    expect(bills).toHaveLength(2);
    const extra = bills.find((bill) => bill.id !== openId);
    expect(extra).toMatchObject({
      id: purchase.billId,
      status: "paid_by_card",
      dueOn: SETTLED_ON,
      paidOn: SETTLED_ON,
      amountUsdc: 20_000_000n,
      overviewHeading: "subscriptions",
      categoryId: card.categoryId,
      payeeId: item.payeeId,
      notes: EXTRA_CARD_PURCHASE_NOTE,
    });
    expect(await readBill(db, card.company, openId)).toMatchObject({
      status: "upcoming",
      amountUsdc: 20_000_000n,
      cardPurchaseId: null,
    });
    expect(
      (await outstandingBillsOfItem(db, card.company, item.itemId)).map(
        (bill) => bill.id,
      ),
    ).toEqual([openId]);
    expect(
      (await readRecurringItem(db, card.company, item.itemId)).nextDueOn,
    ).toBe("2026-12-28");
  });

  it("tells admins when it's more than 20% over the estimate, and not at 20%", async () => {
    // #given an estimate of USD 20.00, twice
    const over = await cardPaidItem();
    await openBill(over);

    // #when USD 24.01, then USD 24.00 on a payment of its own card
    await settle(2_401);
    const atLimitCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
    });
    companyCard = atLimitCard;
    const atLimit = await cardPaidItem({ payeeName: "Vercel" });
    await openBill(atLimit);
    await settle(2_400, VERCEL);

    // #then
    const told = await outboxOf(
      db,
      card.company,
      "card_purchase_over_estimate",
    );
    expect(told.map((row) => row.channel).sort()).toEqual(["email", "push"]);
    expect(told[0]?.body).toBe(
      "Anthropic's Card purchase was USD 24.01, more than its estimate of USD 20.00. Check the price hasn't gone up.",
    );
  });

  it("pays a payment with no estimate without comparing it to anything", async () => {
    // #given
    const item = await cardPaidItem({ estimateCents: null });
    const billId = await openBill(item, { amountUsdc: null, variable: true });

    // #when
    await settle(9_999);

    // #then
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "paid_by_card",
      variable: false,
      amountUsdc: 99_990_000n,
    });
    expect(
      await outboxOf(db, card.company, "card_purchase_over_estimate"),
    ).toEqual([]);
  });
});

describe("a payment whose schedule ended with its last bill still owed", () => {
  const check = (acceptorId = ANTHROPIC) =>
    authorize(app, companyCard.cardToken, randomUUID(), 2_000, {
      acceptorId,
    });

  it("approves its merchant and pays that bill, then declines the merchant", async () => {
    // #given
    const item = await lastBillOwed();
    await knownMerchant(ANTHROPIC, { recurringItemId: item.itemId });

    // #when
    const before = await check();
    await settle(2_000);
    const after = await check();

    // #then
    expect(before.body.result).toBe("APPROVED");
    expect((await readBill(db, card.company, item.billId)).status).toBe(
      "paid_by_card",
    );
    expect(await outstandingBillsOfItem(db, card.company, item.itemId)).toEqual(
      [],
    );
    expect(after.body.result).toBe("UNAUTHORIZED_MERCHANT");
  });

  it("is still the one payment a card's first merchant links to", async () => {
    // #given
    const item = await lastBillOwed();

    // #when
    const token = await settle(2_000);

    // #then
    expect(await purchaseOf(token)).toMatchObject({
      recurringItemId: item.itemId,
      billId: item.billId,
    });
  });

  it("can have a merchant linked to it by an admin", async () => {
    // #given
    const item = await lastBillOwed({ payeeName: "Notion" });
    await cardPaidItem({ payeeName: "Vercel" });
    const purchase = await purchaseOf(await settle(2_000));
    expect(purchase.reviewState).toBe("needs_review");

    // #when
    const response = await review(purchase.id, {
      decision: "link",
      recurringItemId: item.itemId,
    });

    // #then
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await readBill(db, card.company, item.billId)).status).toBe(
      "paid_by_card",
    );
  });
});

describe("applying a settled purchase again", () => {
  it("changes nothing on a second delivery", async () => {
    // #given
    const item = await cardPaidItem();
    const billId = await openBill(item);
    const token = await settle(2_000);

    // #when
    await settle(2_000, ANTHROPIC, token);

    // #then
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
    expect(await billsOfItem(db, card.company, item.itemId)).toHaveLength(2);
    expect(
      (await auditActions(billId)).filter(
        (entry) => entry.action === "bill.paid_by_card",
      ),
    ).toHaveLength(1);
  });

  it("records one payment when two deliveries race", async () => {
    // #given
    const item = await cardPaidItem();
    await openBill(item);
    const token = randomUUID();
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: companyCard.cardToken,
        status: "SETTLED",
        settlement: -2_000,
        acceptorId: ANTHROPIC,
      }),
    );
    paycrest.state.rateGate = barrier(2);

    // #when
    const responses = await Promise.all([
      sendLithicEvent(app, transactionEvent(token)),
      sendLithicEvent(app, transactionEvent(token)),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
    const bills = await billsOfItem(db, card.company, item.itemId);
    expect(bills.map((bill) => bill.status).sort()).toEqual([
      "paid_by_card",
      "upcoming",
    ]);
  });

  it("flags a later amount change and leaves the paid bill as it was", async () => {
    // #given
    const item = await cardPaidItem();
    const billId = await openBill(item);
    const token = await settle(2_000);

    // #when
    await settle(2_300, ANTHROPIC, token);

    // #then
    expect((await purchaseOf(token)).changedAfterExpenseAt).toBeInstanceOf(
      Date,
    );
    expect((await readBill(db, card.company, billId)).amountUsdc).toBe(
      20_000_000n,
    );
  });
});

describe("a declined Card purchase meant for a bill", () => {
  const declined = (token: string) =>
    deliver(token, {
      status: "DECLINED",
      result: "DECLINED",
      detailedResults: ["CARD_SPEND_LIMIT_EXCEEDED"],
      acceptorId: ANTHROPIC,
      merchant: "ANTHROPIC",
    });

  it("marks the bill with why and tells admins once, leaving it owed", async () => {
    // #given
    const item = await cardPaidItem();
    await knownMerchant(ANTHROPIC, { recurringItemId: item.itemId });
    const billId = await openBill(item, { status: "due" });
    const token = randomUUID();

    // #when Lithic tells us twice
    await declined(token);
    await declined(token);

    // #then
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "due",
      cardDeclineReason: "It's over this card's monthly limit.",
    });
    expect(
      (await readBill(db, card.company, billId)).cardDeclinedAt,
    ).toBeInstanceOf(Date);
    const told = await outboxOf(db, card.company, "card_bill_declined");
    expect(told.map((row) => row.channel).sort()).toEqual(["email", "push"]);
    expect(told[0]?.body).toBe(
      "USD 20.00 to Anthropic didn't go through: It's over this card's monthly limit. The bill is still unpaid.",
    );
    expect(await outboxOf(db, card.company, "card_purchase_declined")).toEqual(
      [],
    );
  });

  it("is cleared when a later purchase pays the bill", async () => {
    // #given
    const item = await cardPaidItem();
    await knownMerchant(ANTHROPIC, { recurringItemId: item.itemId });
    const billId = await openBill(item, { status: "due" });
    await declined(randomUUID());

    // #when
    await settle(2_000);

    // #then
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "paid_by_card",
      cardDeclinedAt: null,
      cardDeclineReason: null,
    });
  });

  it("leaves a bill due weeks later alone, and reports the declined purchase instead", async () => {
    // #given
    const item = await cardPaidItem();
    await knownMerchant(ANTHROPIC, { recurringItemId: item.itemId });
    const billId = await openBill(item, { dueOn: "2026-11-28" });

    // #when
    await declined(randomUUID());

    // #then
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "upcoming",
      cardDeclinedAt: null,
    });
    expect(await outboxOf(db, card.company, "card_bill_declined")).toEqual([]);
    expect(
      await outboxOf(db, card.company, "card_purchase_declined"),
    ).toHaveLength(1);
  });
});

describe("the purchase check on a company-held card", () => {
  const check = (acceptorId: string, cardToken = companyCard.cardToken) =>
    authorize(app, cardToken, randomUUID(), 1_000, { acceptorId });

  it("declines a merchant whose payment is paused, ended or paid by another card, or not recognised", async () => {
    // #given
    const paused = await cardPaidItem();
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(recurringItems)
        .set({ active: false })
        .where(eq(recurringItems.id, paused.itemId)),
    );
    const ended = await cardPaidItem({ nextDueOn: null });
    const otherCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
    });
    const moved = await cardPaidItem({ cardId: otherCard.cardId });
    await knownMerchant("acceptor-paused", { recurringItemId: paused.itemId });
    await knownMerchant("acceptor-ended", { recurringItemId: ended.itemId });
    await knownMerchant("acceptor-moved", { recurringItemId: moved.itemId });
    await knownMerchant("acceptor-blocked", { blocked: true });

    // #when
    const results = await Promise.all(
      [
        "acceptor-paused",
        "acceptor-ended",
        "acceptor-moved",
        "acceptor-blocked",
      ].map(async (acceptorId) => (await check(acceptorId)).body.result),
    );

    // #then
    expect(results).toEqual([
      "UNAUTHORIZED_MERCHANT",
      "UNAUTHORIZED_MERCHANT",
      "UNAUTHORIZED_MERCHANT",
      "UNAUTHORIZED_MERCHANT",
    ]);
  });

  it("lets a new merchant and a running payment's merchant through, holding the merchant's key", async () => {
    // #given
    const item = await cardPaidItem();
    await knownMerchant(ANTHROPIC, { recurringItemId: item.itemId });
    const token = randomUUID();

    // #when
    const known = await authorize(app, companyCard.cardToken, token, 1_000, {
      acceptorId: ANTHROPIC,
    });
    const unknown = await check("acceptor-new");

    // #then
    expect([known.body.result, unknown.body.result]).toEqual([
      "APPROVED",
      "APPROVED",
    ]);
    expect(await purchaseOf(token)).toMatchObject({
      merchantKey: ANTHROPIC,
      holdUsdCents: 1_000n,
    });
  });

  it("explains the decline in plain English", async () => {
    // #given
    const token = randomUUID();

    // #when
    await deliver(token, {
      status: "DECLINED",
      result: "UNAUTHORIZED_MERCHANT",
      detailedResults: [],
      acceptorId: "acceptor-blocked",
    });

    // #then
    expect((await purchaseOf(token)).declineReason).toBe(
      "This merchant isn't allowed on this card.",
    );
  });

  it("never turns a merchant away from a person's card", async () => {
    // #given the same merchant ID blocked on the company-held card
    await knownMerchant("acceptor-blocked", { blocked: true });

    // #when
    const result = await check("acceptor-blocked", card.cardToken);

    // #then
    expect(result.body.result).toBe("APPROVED");
  });
});

describe("receipts for a company-held card's purchases", () => {
  it("never asks for one on a purchase that pays, or will pay, a bill, and asks admins for the rest", async () => {
    // #given one paid, one matched and still held, and one from a merchant
    // the card doesn't know
    const item = await cardPaidItem();
    await openBill(item);
    const paid = await settle(2_000);
    const held = randomUUID();
    await authorize(app, companyCard.cardToken, held, 500, {
      acceptorId: ANTHROPIC,
    });
    await deliver(held, { hold: -500, acceptorId: ANTHROPIC });
    const unknown = await settle(700, VERCEL);
    await review((await purchaseOf(unknown)).id, { decision: "one_off" });

    // #when
    const list = await dataOf(
      await sendJson(
        app,
        purchasesPath("?needsReceipt=true"),
        card.company.admin,
      ),
      cardPurchaseListSchema,
    );
    const views = await Promise.all(
      [paid, held].map(async (token) =>
        dataOf(
          await sendJson(
            app,
            purchasesPath(`/${(await purchaseOf(token)).id}`),
            card.company.admin,
          ),
          cardPurchaseSchema,
        ),
      ),
    );
    await runtime.runPromise(
      runCardReceiptReminders(new Date("2026-11-20T09:00:00+03:00")),
    );

    // #then
    const unknownId = (await purchaseOf(unknown)).id;
    expect(list.purchases.map((purchase) => purchase.id)).toEqual([unknownId]);
    expect(views.map((view) => [view.needsReceipt, view.match?.state])).toEqual(
      [
        [false, "matched"],
        [false, "matched"],
      ],
    );
    const asked = await outboxOf(db, card.company, "card_receipt_needed");
    expect(asked.map((row) => row.dedupeKey)).toEqual([
      `card_receipt_needed:${unknownId}`,
    ]);
    const reminded = await outboxOf(db, card.company, "card_receipt_reminder");
    expect(reminded.map((row) => row.dedupeKey)).toEqual([
      `card_receipt_reminder:${unknownId}:2026-11-20`,
    ]);
    const { rows: audiences } = await owner.query<{ audience: string }>(
      "SELECT DISTINCT audience FROM notification_outbox WHERE organization_id = $1 AND kind IN ('card_receipt_needed', 'card_receipt_reminder')",
      [card.company.organizationId],
    );
    expect(audiences).toEqual([{ audience: "admins" }]);
  });

  it("asks for none while a purchase waits for an answer, and for one once it's a one-off", async () => {
    // #given
    await cardPaidItem();
    await cardPaidItem({ payeeName: "Vercel" });
    const purchase = await purchaseOf(await settle(700, "acceptor-figma"));
    const viewOf = async () =>
      dataOf(
        await sendJson(
          app,
          purchasesPath(`/${purchase.id}`),
          card.company.admin,
        ),
        cardPurchaseSchema,
      );
    const listed = async () =>
      (
        await dataOf(
          await sendJson(
            app,
            purchasesPath("?needsReceipt=true"),
            card.company.admin,
          ),
          cardPurchaseListSchema,
        )
      ).purchases.map((each) => each.id);

    // #when
    const waiting = await viewOf();
    const listedWhileWaiting = await listed();
    await runtime.runPromise(
      runCardReceiptReminders(new Date("2026-11-20T09:00:00+03:00")),
    );
    const askedWhileWaiting = await outboxOf(
      db,
      card.company,
      "card_receipt_needed",
    );
    const remindedWhileWaiting = await outboxOf(
      db,
      card.company,
      "card_receipt_reminder",
    );
    await review(purchase.id, { decision: "one_off" });

    // #then
    expect(waiting.needsReceipt).toBe(false);
    expect(listedWhileWaiting).toEqual([]);
    expect(askedWhileWaiting).toEqual([]);
    expect(remindedWhileWaiting).toEqual([]);
    expect((await viewOf()).needsReceipt).toBe(true);
    expect(await listed()).toEqual([purchase.id]);
    expect(
      (await outboxOf(db, card.company, "card_receipt_needed")).map(
        (row) => row.dedupeKey,
      ),
    ).toEqual([`card_receipt_needed:${purchase.id}`]);
  });
});

describe("POST …/cards/purchases/:purchaseId/review", () => {
  async function awaitingAnswer(cents = 1_000, acceptorId = ANTHROPIC) {
    const token = await settle(cents, acceptorId);
    const purchase = await purchaseOf(token);
    expect(purchase.reviewState).toBe("needs_review");
    return purchase;
  }

  /** Two recurring payments on the card, so a new merchant has to be asked about. */
  async function twoPayments() {
    const anthropic = await cardPaidItem();
    const vercel = await cardPaidItem({ payeeName: "Vercel" });
    return { anthropic, vercel };
  }

  it("links a held purchase, whose settling then pays the bill, and answers its merchant's other purchases", async () => {
    // #given
    const { anthropic } = await twoPayments();
    const billId = await openBill(anthropic);
    const held = randomUUID();
    await authorize(app, companyCard.cardToken, held, 2_000, {
      acceptorId: ANTHROPIC,
    });
    await deliver(held, { hold: -2_000, acceptorId: ANTHROPIC });
    const another = randomUUID();
    await deliver(another, { hold: -300, acceptorId: ANTHROPIC });

    // #when
    const view = await dataOf(
      await review((await purchaseOf(held)).id, {
        decision: "link",
        recurringItemId: anthropic.itemId,
      }),
      cardPurchaseSchema,
    );
    await settle(2_000, ANTHROPIC, held);

    // #then
    expect(view.match).toEqual({
      state: "matched",
      recurringItemId: anthropic.itemId,
      billId: null,
      payeeName: "Anthropic",
    });
    expect(await purchaseOf(another)).toMatchObject({
      recurringItemId: anthropic.itemId,
      reviewState: null,
    });
    expect(await purchaseOf(held)).toMatchObject({ billId });
    expect((await readBill(db, card.company, billId)).status).toBe(
      "paid_by_card",
    );
    expect(
      (await auditActions((await purchaseOf(held)).id)).map(
        (entry) => entry.action,
      ),
    ).toContain("card_purchase.reviewed");
  });

  it("turns a settled purchase's Card expense into the bill's payment, keeping one expense", async () => {
    // #given
    const { anthropic } = await twoPayments();
    const billId = await openBill(anthropic);
    const purchase = await awaitingAnswer(2_150);
    const [cardExpense] = await cardExpensesOf(db, card.company);

    // #when
    const response = await review(purchase.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });

    // #then
    const view = await dataOf(response, cardPurchaseSchema);
    expect(view.match).toMatchObject({ state: "matched", billId });
    expect(view.needsReceipt).toBe(false);
    expect(await cardExpensesOf(db, card.company)).toEqual([
      expect.objectContaining({
        id: cardExpense?.id,
        billId,
        overviewHeading: "subscriptions",
        merchant: "Anthropic",
        amountKes: cardExpense?.amountKes,
      }),
    ]);
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "paid_by_card",
      amountUsdc: 21_500_000n,
      cardPurchaseId: purchase.id,
    });
  });

  it("pays the bills of the merchant's waiting purchases oldest first, whichever one is answered", async () => {
    // #given October's bill overdue, and a purchase settled in October and
    // another in November, both waiting
    const anthropic = await cardPaidItem({ nextDueOn: "2026-11-11" });
    await cardPaidItem({ payeeName: "Vercel" });
    const overdueId = await openBill(anthropic, {
      dueOn: "2026-10-11",
      status: "overdue",
    });
    const settleOn = async (created: string) => {
      const token = randomUUID();
      await deliver(token, {
        status: "SETTLED",
        settlement: -2_000,
        acceptorId: ANTHROPIC,
        merchant: "ANTHROPIC",
        events: ["AUTHORIZATION", "CLEARING"],
        created,
      });
      return purchaseOf(token);
    };
    const october = await settleOn("2026-10-12T10:00:00Z");
    const november = await settleOn("2026-11-08T10:00:00Z");

    // #when the newer one is answered
    const response = await review(november.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });

    // #then
    expect(response.status, await response.clone().text()).toBe(200);
    const bills = await billsOfItem(db, card.company, anthropic.itemId);
    expect(
      bills.map((bill) => [bill.dueOn, bill.status, bill.cardPurchaseId]),
    ).toEqual([
      ["2026-10-11", "paid_by_card", october.id],
      ["2026-11-11", "paid_by_card", november.id],
      ["2026-12-11", expect.any(String), null],
    ]);
    expect((await readBill(db, card.company, overdueId)).paidOn).toBe(
      "2026-10-12",
    );
  });

  it("answers at most 50 of the merchant's waiting purchases at once, oldest first", async () => {
    // #given 51 held purchases from the merchant, a minute apart
    const { anthropic } = await twoPayments();
    const tokens: string[] = [];
    for (let minute = 0; minute < 51; minute += 1) {
      const token = randomUUID();
      await deliver(token, {
        hold: -100,
        acceptorId: ANTHROPIC,
        created: new Date(Date.UTC(2026, 10, 8, 10, minute)).toISOString(),
      });
      tokens.push(token);
    }
    const newest = await purchaseOf(tokens[50] ?? "");

    // #when the newest is answered, then answered again
    const first = await review(newest.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });
    const afterFirst = await Promise.all(tokens.map(purchaseOf));
    const again = await review(newest.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });

    // #then
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(
      afterFirst
        .slice(0, 50)
        .every((each) => each.recurringItemId === anthropic.itemId),
    ).toBe(true);
    expect(afterFirst[50]).toMatchObject({
      recurringItemId: null,
      reviewState: "needs_review",
    });
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({ recurringItemId: anthropic.itemId }),
    ]);
    expect(
      (await purchaseOf(newest.lithicTransactionToken)).recurringItemId,
    ).toBe(anthropic.itemId);
  });

  it("takes two answers for a merchant's waiting purchases at the same moment one after the other, never failing", async () => {
    // #given
    const { anthropic } = await twoPayments();
    const oneOff: ReviewCardPurchaseRequest = { decision: "one_off" };
    const link: ReviewCardPurchaseRequest = {
      decision: "link",
      recurringItemId: anthropic.itemId,
    };
    const rounds = [oneOff, link, oneOff, link].map(
      (answer, round) => [`acceptor-race-${String(round)}`, answer] as const,
    );

    for (const [acceptorId, answer] of rounds) {
      const first = await awaitingAnswer(1_000, acceptorId);
      const second = await awaitingAnswer(1_100, acceptorId);

      // #when two admins answer one each, as the merchant comes free
      const responses = await whileMerchantHeld(acceptorId, 2, () =>
        Promise.all([review(first.id, answer), review(second.id, answer)]),
      );

      // #then the first answer goes to both; the second finds them answered
      expect(
        responses.map((response) => response.status).sort(),
        await Promise.all(
          responses.map((response) => response.clone().text()),
        ).then((bodies) => bodies.join("\n")),
      ).toEqual(answer.decision === "link" ? [200, 409] : [200, 200]);
      const after = await Promise.all(
        [first, second].map((each) => purchaseOf(each.lithicTransactionToken)),
      );
      expect(
        after.map(({ reviewState, recurringItemId }) => ({
          reviewState,
          recurringItemId,
        })),
      ).toEqual(
        Array(2).fill(
          answer.decision === "link"
            ? { reviewState: null, recurringItemId: anthropic.itemId }
            : { reviewState: "one_off", recurringItemId: null },
        ),
      );
      for (const each of after) {
        expect(
          (await auditActions(each.id)).filter(
            (entry) => entry.action === "card_purchase.reviewed",
          ),
        ).toHaveLength(1);
      }
    }
  });

  it("keeps a purchase whose amount changed after its Card expense as a one-off, and links the merchant", async () => {
    // #given its Card expense recorded USD 10.00, then it settled at 12.00
    const { anthropic } = await twoPayments();
    const billId = await openBill(anthropic);
    const purchase = await awaitingAnswer(1_000);
    await settle(1_200, ANTHROPIC, purchase.lithicTransactionToken);
    expect(
      (await purchaseOf(purchase.lithicTransactionToken)).changedAfterExpenseAt,
    ).toBeInstanceOf(Date);

    // #when
    const response = await review(purchase.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });
    const later = await settle(2_000);

    // #then
    const view = await dataOf(response, cardPurchaseSchema);
    expect(view.match?.state).toBe("one_off");
    expect((await cardExpensesOf(db, card.company))[0]?.billId).toBeNull();
    expect(await purchaseOf(later)).toMatchObject({
      recurringItemId: anthropic.itemId,
      billId,
    });
  });

  it("keeps a purchase that came to nothing as a one-off, paying no bill, and links the merchant", async () => {
    // #given its Card expense was recorded, then its amount came to zero
    const { anthropic } = await twoPayments();
    const billId = await openBill(anthropic);
    const purchase = await awaitingAnswer();
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(cardPurchases)
        .set({ settledUsdCents: 0n })
        .where(eq(cardPurchases.id, purchase.id)),
    );

    // #when
    const response = await review(purchase.id, {
      decision: "link",
      recurringItemId: anthropic.itemId,
    });
    const later = await settle(2_000);

    // #then
    const view = await dataOf(response, cardPurchaseSchema);
    expect(view.match?.state).toBe("one_off");
    expect((await cardExpensesOf(db, card.company))[0]?.billId).toBeNull();
    const [entry] = (await auditActions(purchase.id)).filter(
      (each) => each.action === "card_purchase.reviewed",
    );
    expect(entry?.after).toMatchObject({ outcome: "kept_card_expense" });
    expect(await purchaseOf(later)).toMatchObject({
      recurringItemId: anthropic.itemId,
      billId,
    });
  });

  it("keeps a Card expense already queued for Zoho as a one-off, and links the merchant for later purchases", async () => {
    // #given its expense was completed with an admin's reason, so it's queued
    await connectAccounting(db, card.company);
    const { anthropic } = await twoPayments();
    const billId = await openBill(anthropic);
    const purchase = await awaitingAnswer();
    const waived = await sendJson(
      app,
      purchasesPath(`/${purchase.id}/no-receipt`),
      card.company.admin,
      { method: "POST", body: { reason: "Billed by email only" } },
    );
    expect(waived.status).toBe(200);

    // #when
    const view = await dataOf(
      await review(purchase.id, {
        decision: "link",
        recurringItemId: anthropic.itemId,
      }),
      cardPurchaseSchema,
    );
    const later = await settle(2_000);

    // #then
    expect(view.match?.state).toBe("one_off");
    expect((await cardExpensesOf(db, card.company))[0]?.billId).toBeNull();
    expect(await purchaseOf(later)).toMatchObject({
      recurringItemId: anthropic.itemId,
      billId,
    });
    const [entry] = await auditActions(purchase.id).then((entries) =>
      entries.filter((each) => each.action === "card_purchase.reviewed"),
    );
    expect(entry?.after).toMatchObject({ outcome: "kept_card_expense" });
  });

  it("makes a one-off of the merchant's later purchases without asking again", async () => {
    // #given
    await twoPayments();
    const purchase = await awaitingAnswer();

    // #when
    const view = await dataOf(
      await review(purchase.id, { decision: "one_off" }),
      cardPurchaseSchema,
    );
    const later = await settle(700);

    // #then
    expect(view.match?.state).toBe("one_off");
    expect(view.needsReceipt).toBe(true);
    expect(await purchaseOf(later)).toMatchObject({
      reviewState: "one_off",
      reviewedBy: null,
    });
    expect(
      await outboxOf(db, card.company, "card_purchase_needs_review"),
    ).toHaveLength(2);
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({ recurringItemId: null, blocked: false }),
    ]);
  });

  it("blocks a merchant nobody recognises, so the card declines it from then on", async () => {
    // #given
    await twoPayments();
    const purchase = await awaitingAnswer();

    // #when
    const view = await dataOf(
      await review(purchase.id, { decision: "not_recognised" }),
      cardPurchaseSchema,
    );
    const next = await authorize(
      app,
      companyCard.cardToken,
      randomUUID(),
      1_000,
      { acceptorId: ANTHROPIC },
    );

    // #then
    expect(view.match?.state).toBe("not_recognised");
    expect(view.needsReceipt).toBe(false);
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({ blocked: true, recurringItemId: null }),
    ]);
    expect(next.body.result).toBe("UNAUTHORIZED_MERCHANT");
  });

  it("asks nobody for a receipt for a purchase nobody recognises, and still sends its Card expense to Zoho", async () => {
    // #given one purchase settled and one held, both waiting
    await connectAccounting(db, card.company);
    await twoPayments();
    const settled = await awaitingAnswer();
    const held = randomUUID();
    await authorize(app, companyCard.cardToken, held, 500, {
      acceptorId: ANTHROPIC,
    });
    await deliver(held, { hold: -500, acceptorId: ANTHROPIC });

    // #when nobody recognises the merchant, and then the held one settles
    const view = await dataOf(
      await review(settled.id, { decision: "not_recognised" }),
      cardPurchaseSchema,
    );
    await settle(500, ANTHROPIC, held);
    const listed = await dataOf(
      await sendJson(
        app,
        purchasesPath("?needsReceipt=true"),
        card.company.admin,
      ),
      cardPurchaseListSchema,
    );
    await runtime.runPromise(
      runCardReceiptReminders(new Date("2026-11-20T09:00:00+03:00")),
    );

    // #then
    expect(view).toMatchObject({
      needsReceipt: false,
      noReceiptReason: "Not recognised by an admin",
    });
    const both = await Promise.all(
      [settled.lithicTransactionToken, held].map(purchaseOf),
    );
    expect(both.map((each) => each.reviewState)).toEqual([
      "not_recognised",
      "not_recognised",
    ]);
    const expenses = await cardExpensesOf(db, card.company);
    expect(
      both.map(
        (each) =>
          expenses.find((expense) => expense.id === each.expenseId)
            ?.noReceiptReason,
      ),
    ).toEqual(["Not recognised by an admin", "Not recognised by an admin"]);
    expect(
      (await accountingSyncsOf(db, card.company))
        .filter(({ subjectType }) => subjectType === "expense")
        .map(({ subjectId }) => subjectId)
        .sort(),
    ).toEqual(both.map((each) => each.expenseId).sort());
    expect(listed.purchases).toEqual([]);
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual([]);
    expect(await outboxOf(db, card.company, "card_receipt_reminder")).toEqual(
      [],
    );
  });

  it("unlinks and blocks a linked merchant nobody recognises, leaving the bill it paid paid", async () => {
    // #given a stranger took a one-payment card's link: one purchase paid
    // the bill, a second is still held
    const item = await cardPaidItem();
    const billId = await openBill(item);
    const paid = await purchaseOf(await settle(2_000, "acceptor-stranger"));
    expect(paid.billId).toBe(billId);
    const held = randomUUID();
    await deliver(held, { hold: -900, acceptorId: "acceptor-stranger" });

    // #when
    const response = await review(paid.id, { decision: "not_recognised" });
    await settle(900, "acceptor-stranger", held);
    const next = await authorize(
      app,
      companyCard.cardToken,
      randomUUID(),
      500,
      {
        acceptorId: "acceptor-stranger",
      },
    );

    // #then
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await merchantsOfCard()).toEqual([
      expect.objectContaining({ recurringItemId: null, blocked: true }),
    ]);
    expect(await purchaseOf(paid.lithicTransactionToken)).toMatchObject({
      recurringItemId: item.itemId,
      billId,
      reviewState: null,
    });
    expect(await readBill(db, card.company, billId)).toMatchObject({
      status: "paid_by_card",
      cardPurchaseId: paid.id,
    });
    const [entry] = (await auditActions(paid.id)).filter(
      (each) => each.action === "card_purchase.reviewed",
    );
    expect(entry?.after).toMatchObject({
      decision: "not_recognised",
      outcome: "bill_stays_paid",
      billId,
    });
    expect(await purchaseOf(held)).toMatchObject({
      recurringItemId: null,
      billId: null,
      reviewState: "not_recognised",
    });
    expect(
      (await outstandingBillsOfItem(db, card.company, item.itemId)).map(
        (bill) => bill.cardPurchaseId,
      ),
    ).toEqual([null]);
    expect(next.body.result).toBe("UNAUTHORIZED_MERCHANT");
  });

  describe("once the merchant's payment moved to another card", () => {
    async function moveToAnotherCard(itemId: string): Promise<void> {
      const otherCard = await addCompanyHeldCard(db, card.company, {
        defaultCategoryId: card.categoryId,
      });
      const moved = await sendJson(
        app,
        `/organizations/${card.company.organizationId}/recurring-items/${itemId}`,
        card.company.admin,
        {
          method: "PATCH",
          body: { payVia: "card", cardId: otherCard.cardId },
        },
      );
      expect(moved.status, await moved.clone().text()).toBe(200);
    }

    async function askedAbout(purchaseId: string): Promise<boolean> {
      const asked = await outboxOf(
        db,
        card.company,
        "card_purchase_needs_review",
      );
      return asked.some(
        (row) => row.dedupeKey === `card_purchase_needs_review:${purchaseId}`,
      );
    }

    it("asks again about a merchant answered one-off before an admin linked it", async () => {
      // #given a one-off, then a later purchase an admin linked to Anthropic
      const { anthropic } = await twoPayments();
      const oneOff = await awaitingAnswer();
      await review(oneOff.id, { decision: "one_off" });
      const later = await purchaseOf(await settle(1_200));
      expect(later.reviewState).toBe("one_off");
      const linked = await review(later.id, {
        decision: "link",
        recurringItemId: anthropic.itemId,
      });
      expect(linked.status, await linked.clone().text()).toBe(200);

      // #when Anthropic moves to another card, and the merchant charges this one
      await moveToAnotherCard(anthropic.itemId);
      const next = await purchaseOf(await settle(1_300));

      // #then
      expect(next).toMatchObject({
        reviewState: "needs_review",
        recurringItemId: null,
      });
      expect(await askedAbout(next.id)).toBe(true);
    });

    it("asks again about a merchant whose one-off was kept as a Card expense when it was linked", async () => {
      // #given the one-off's expense is queued for Zoho, so linking keeps it
      await connectAccounting(db, card.company);
      const { anthropic } = await twoPayments();
      const purchase = await awaitingAnswer();
      const waived = await sendJson(
        app,
        purchasesPath(`/${purchase.id}/no-receipt`),
        card.company.admin,
        { method: "POST", body: { reason: "Billed by email only" } },
      );
      expect(waived.status).toBe(200);
      const kept = await dataOf(
        await review(purchase.id, {
          decision: "link",
          recurringItemId: anthropic.itemId,
        }),
        cardPurchaseSchema,
      );
      expect(kept.match?.state).toBe("one_off");

      // #when Anthropic moves to another card, and the merchant charges this one
      await moveToAnotherCard(anthropic.itemId);
      const next = await purchaseOf(await settle(1_300));

      // #then
      expect(next).toMatchObject({
        reviewState: "needs_review",
        recurringItemId: null,
      });
      expect(await askedAbout(next.id)).toBe(true);
    });
  });

  it("refuses what it can't answer, plainly", async () => {
    // #given
    const { anthropic } = await twoPayments();
    const ended = await cardPaidItem({ payeeName: "Notion", nextDueOn: null });
    const otherCard = await addCompanyHeldCard(db, card.company, {
      defaultCategoryId: card.categoryId,
    });
    const elsewhere = await cardPaidItem({
      payeeName: "Figma",
      cardId: otherCard.cardId,
    });
    const purchase = await awaitingAnswer();
    const matchedToken = randomUUID();
    await knownMerchant(VERCEL, { recurringItemId: anthropic.itemId });
    await settle(500, VERCEL, matchedToken);
    const personal = randomUUID();
    lithic.state.transactions.set(
      personal,
      fakeLithicTransaction({
        token: personal,
        cardToken: card.cardToken,
        status: "SETTLED",
        settlement: -500,
      }),
    );
    await sendLithicEvent(app, transactionEvent(personal));

    // #when
    const responses = await Promise.all([
      review(purchase.id, {
        decision: "link",
        recurringItemId: elsewhere.itemId,
      }),
      review(purchase.id, { decision: "link", recurringItemId: ended.itemId }),
      review((await purchaseOf(matchedToken)).id, { decision: "one_off" }),
      review((await purchaseOf(personal)).id, { decision: "one_off" }),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      400, 409, 409, 409,
    ]);
    expect(await errorOf(responses[0])).toBe(
      "Pick one of this card's recurring payments.",
    );
    expect(await purchaseOf(purchase.lithicTransactionToken)).toMatchObject({
      reviewState: "needs_review",
    });
  });

  it("refuses a merchant already linked to another of the card's payments", async () => {
    // #given a one-off whose merchant was later linked to Anthropic
    const { anthropic, vercel } = await twoPayments();
    const purchase = await awaitingAnswer();
    await review(purchase.id, { decision: "one_off" });
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(cardMerchants)
        .set({ recurringItemId: anthropic.itemId })
        .where(eq(cardMerchants.cardId, companyCard.cardId)),
    );

    // #when
    const response = await review(purchase.id, {
      decision: "link",
      recurringItemId: vercel.itemId,
    });

    // #then
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(
      "This merchant already pays another of the card's recurring payments.",
    );
  });

  it("is for admins only", async () => {
    // #given
    const { anthropic } = await twoPayments();
    const purchase = await awaitingAnswer();
    const accountant = await createUser(db);
    await addMember(db, card.company, accountant, { role: "accountant" });

    // #when
    const responses = await Promise.all(
      [card.holder, accountant].map((user) =>
        review(
          purchase.id,
          { decision: "link", recurringItemId: anthropic.itemId },
          user,
        ),
      ),
    );

    // #then
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(
      (await purchaseOf(purchase.lithicTransactionToken)).reviewState,
    ).toBe("needs_review");
  });

  it("lists what waits for an answer", async () => {
    // #given
    await twoPayments();
    const purchase = await awaitingAnswer();
    await settle(400, VERCEL);
    await review((await purchaseOf(await settle(300, "acceptor-figma"))).id, {
      decision: "one_off",
    });

    // #when
    const list = await dataOf(
      await sendJson(
        app,
        purchasesPath("?needsReview=true"),
        card.company.admin,
      ),
      cardPurchaseListSchema,
    );

    // #then
    expect(list.purchases.map((each) => each.merchantKey).sort()).toEqual([
      ANTHROPIC,
      VERCEL,
    ]);
    expect(list.purchases.map((each) => each.id)).toContain(purchase.id);
  });
});

describe("the Card balance short warning", () => {
  it("reaches admins by push and email, once a Nairobi day", async () => {
    // #given
    const event = {
      kind: "card_balance_short",
      organizationId: card.company.organizationId,
      today: "2026-11-13",
      dueUsdCents: 12_500n,
      availableUsdCents: -300n,
    } as const;

    // #when
    await runInScope(db, asAdmin(), (tx) =>
      Effect.runPromise(Effect.zipRight(notify(tx, event), notify(tx, event))),
    );

    // #then
    const told = await outboxOf(db, card.company, "card_balance_short");
    expect(told.map((row) => row.channel).sort()).toEqual(["email", "push"]);
    expect(told[0]?.body).toBe(
      "Your company-held cards' recurring payments need USD 125.00 soon, and USD 0.00 is left. Load more so they aren't declined.",
    );
  });
});
