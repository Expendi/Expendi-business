import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cardPurchaseListSchema,
  cardPurchaseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { CardCompany } from "../helpers/card-purchases.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { cardPurchases, receiptFiles } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { readCardBalance } from "../../services/cards/balance.js";
import { reconcileCardPurchases } from "../../services/cards/reconcile.js";
import { runCardReceiptReminders } from "../../services/cards/reminders.js";
import { reportMonthSummary } from "../../services/export/summary.js";
import {
  accountingSyncsOf,
  authorize,
  cardExpensesOf,
  connectAccounting,
  createCardCompany,
  outboxOf,
  readExpense,
  readPurchaseByToken,
  sendLithicEvent,
  transactionEvent,
} from "../helpers/card-purchases.js";
import { addCategory, uploadReceipt } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  fakeLithicTransaction,
  makeFakeFileStorage,
  makeFakeLithic,
  makeFakePaycrest,
} from "../helpers/fakes.js";
import { barrier, bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const lithic = makeFakeLithic();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({
    lithic: lithic.layer,
    paycrest: paycrest.layer,
    fileStorage: storage.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

let card: CardCompany;

beforeEach(async () => {
  lithic.state.reset();
  paycrest.state.reset();
  card = await createCardCompany(db);
});

type TransactionFields = Parameters<typeof fakeLithicTransaction>[0];

/** Puts `fields` at Lithic for this card and delivers an event about them. */
async function deliver(
  token: string,
  fields: Omit<TransactionFields, "token" | "cardToken"> = {},
) {
  lithic.state.transactions.set(
    token,
    fakeLithicTransaction({ token, cardToken: card.cardToken, ...fields }),
  );
  return sendLithicEvent(app, transactionEvent(token));
}

const newToken = (): string => randomUUID();

/** Every company's purchases share the table, however few a test added. */
const RECONCILE_EVERYTHING = 10_000;

const balance = () =>
  runInScope(db, { organizationId: card.company.organizationId }, (tx) =>
    Effect.runPromise(readCardBalance(tx, card.company.organizationId)),
  );

const memberRequest = (
  user: { readonly privyUserId: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
) =>
  app.request(`/organizations/${card.company.organizationId}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...bearer(user.privyUserId),
      "content-type": "application/json",
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });

const signatureFailures = async (): Promise<number> => {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*) FROM ops_alerts WHERE kind = 'webhook_signature_failure' AND subject_key = 'lithic'",
  );
  return Number(rows[0]?.count);
};

describe("POST /webhooks/lithic", () => {
  it("refuses a bad signature and raises an ops alert", async () => {
    lithic.state.signaturesValid = false;
    const response = await sendLithicEvent(app, transactionEvent(newToken()));
    expect(response.status).toBe(401);
    expect(await signatureFailures()).toBeGreaterThan(0);
  });

  it("answers 200 for events it doesn't handle and looks nothing up", async () => {
    lithic.state.failGetTransaction = true;
    expect(
      (await sendLithicEvent(app, { event_type: "card.created", payload: {} }))
        .status,
    ).toBe(200);
    expect(
      (await sendLithicEvent(app, { event_type: "card_transaction.updated" }))
        .status,
    ).toBe(200);
  });

  it("takes the token from the top of the body when it has a card_token", async () => {
    const token = newToken();
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: card.cardToken,
        hold: -1000,
      }),
    );
    const response = await sendLithicEvent(app, {
      token,
      card_token: card.cardToken,
    });
    expect(response.status).toBe(200);
    expect(await readPurchaseByToken(db, card.company, token)).not.toBeNull();
  });

  it("re-fetches from Lithic, so a delivery only says which one changed", async () => {
    const token = newToken();
    lithic.state.failGetTransaction = true;
    const response = await deliver(token, { hold: -1000 });
    expect(response.status).toBe(500);
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
  });

  it("changes nothing on a duplicate delivery", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 2500);
    await deliver(token, { status: "SETTLED", settlement: -2500 });
    const before = await readPurchaseByToken(db, card.company, token);
    const receiptNeeded = await outboxOf(
      db,
      card.company,
      "card_receipt_needed",
    );
    expect(
      await deliver(token, { status: "SETTLED", settlement: -2500 }),
    ).toMatchObject({ status: 200 });
    const after = await readPurchaseByToken(db, card.company, token);
    expect(after).toEqual(before);
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual(
      receiptNeeded,
    );
  });

  it("carries an authorized purchase through settlement into a Card expense", async () => {
    const token = newToken();
    const authorization = await authorize(app, card.cardToken, token, 2500);
    expect(authorization).toEqual({
      status: 200,
      body: { token, result: "APPROVED" },
    });
    const held = await readPurchaseByToken(db, card.company, token);
    expect(held).toMatchObject({
      status: "pending",
      kind: "purchase",
      holdUsdCents: 2500n,
      settledUsdCents: 0n,
      membershipId: card.holderMembershipId,
      categoryId: card.categoryId,
      merchant: "ACME SOFTWARE",
    });
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual([]);

    expect(await deliver(token, { hold: -2500 })).toMatchObject({
      status: 200,
    });
    const firstSeen = await outboxOf(db, card.company, "card_receipt_needed");
    expect(firstSeen).toHaveLength(1);

    expect(
      await deliver(token, {
        status: "SETTLED",
        settlement: -2500,
        events: ["AUTHORIZATION", "CLEARING"],
      }),
    ).toMatchObject({ status: 200 });
    const settled = await readPurchaseByToken(db, card.company, token);
    expect(settled).toMatchObject({
      status: "settled",
      holdUsdCents: 0n,
      settledUsdCents: 2500n,
      usdKesRate: "128.68",
    });
    if (!settled?.expenseId) throw new Error("no Card expense was recorded");
    expect(
      await readExpense(db, card.company, settled.expenseId),
    ).toMatchObject({
      kind: "card",
      status: "recorded",
      source: "app",
      overviewHeading: "transactions",
      membershipId: card.holderMembershipId,
      paidFromAccountId: card.accountId,
      merchant: "ACME SOFTWARE",
      spentOn: "2026-11-08",
      amountKes: 321_700n,
      categoryId: card.categoryId,
    });
    // Asked for a receipt once however many deliveries it took.
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual(
      firstSeen,
    );
    const { rows: audits } = await owner.query(
      "SELECT action FROM audit_log WHERE action = 'expense.recorded' AND organization_id = $1",
      [card.company.organizationId],
    );
    expect(audits).toHaveLength(1);
  });

  it("dates the expense by the clearing, in Nairobi, not the authorization", async () => {
    const token = newToken();
    const settled = fakeLithicTransaction({
      token,
      cardToken: card.cardToken,
      status: "SETTLED",
      settlement: -2500,
      created: "2026-10-30T10:00:00Z",
      events: ["AUTHORIZATION", "CLEARING"],
    });
    lithic.state.transactions.set(token, {
      ...settled,
      events: settled.events.map((event) => ({
        ...event,
        created:
          event.type === "CLEARING"
            ? "2026-11-01T22:30:00Z"
            : "2026-10-30T10:00:00Z",
      })),
    });
    await sendLithicEvent(app, transactionEvent(token));
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.spentOn).toBe("2026-11-02");
    const purchase = await readPurchaseByToken(db, card.company, token);
    expect(purchase?.authorizedAt.toISOString()).toBe(
      "2026-10-30T10:00:00.000Z",
    );
  });

  it("makes no expense for a $10 hold cleared for $7 until the hold is gone", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 1000);
    await deliver(token, {
      status: "SETTLED",
      settlement: -700,
      hold: -300,
    });
    expect(await cardExpensesOf(db, card.company)).toEqual([]);
    const partly = await readPurchaseByToken(db, card.company, token);
    expect(partly).toMatchObject({
      status: "settled",
      holdUsdCents: 300n,
      settledUsdCents: 700n,
      expenseId: null,
    });

    await deliver(token, { status: "SETTLED", settlement: -700, hold: 0 });
    const expenses = await cardExpensesOf(db, card.company);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.amountKes).toBe(90_076n);
  });

  it("records what actually settled when a $54 hold clears at $60", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 5400);
    await deliver(token, { status: "SETTLED", settlement: -6000 });
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.amountKes).toBe(772_080n);
    expect(await readPurchaseByToken(db, card.company, token)).toMatchObject({
      holdUsdCents: 0n,
      settledUsdCents: 6000n,
    });
  });

  it.each([
    ["VOIDED", {}],
    ["EXPIRED", {}],
    [
      "DECLINED",
      {
        result: "DECLINED",
        detailedResults: ["CARD_SPEND_LIMIT_EXCEEDED"],
      },
    ],
  ] as const)("makes no expense for a %s purchase", async (status, fields) => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 1500);
    expect(await deliver(token, { status, ...fields })).toMatchObject({
      status: 200,
    });
    const purchase = await readPurchaseByToken(db, card.company, token);
    expect(purchase?.status).toBe(status.toLowerCase());
    expect(purchase?.expenseId).toBeNull();
    expect(purchase?.holdUsdCents).toBe(0n);
    expect((await balance()).onHold).toBe(0n);
    expect(await cardExpensesOf(db, card.company)).toEqual([]);
  });

  it("explains a decline in plain English, once", async () => {
    const limit = newToken();
    await deliver(limit, {
      status: "DECLINED",
      result: "DECLINED",
      detailedResults: ["CARD_SPEND_LIMIT_EXCEEDED"],
    });
    await deliver(limit, {
      status: "DECLINED",
      result: "DECLINED",
      detailedResults: ["CARD_SPEND_LIMIT_EXCEEDED"],
    });
    expect(await readPurchaseByToken(db, card.company, limit)).toMatchObject({
      declineReason: "It's over this card's monthly limit.",
    });

    const notEnough = newToken();
    await deliver(notEnough, {
      status: "DECLINED",
      result: "INSUFFICIENT_FUNDS",
      detailedResults: ["INSUFFICIENT_FUNDS"],
    });
    expect(
      await readPurchaseByToken(db, card.company, notEnough),
    ).toMatchObject({
      declineReason: "There isn't enough in the Card balance.",
    });

    const declines = await outboxOf(db, card.company, "card_purchase_declined");
    expect(declines).toHaveLength(2);
    expect(declines.map((row) => row.body)).toContain(
      "ACME SOFTWARE: It's over this card's monthly limit.",
    );
  });

  it("makes no expense for a refund, and puts it back in the Card balance", async () => {
    const token = newToken();
    await deliver(token, {
      status: "SETTLED",
      settlement: 1500,
      events: ["RETURN"],
    });
    expect(await readPurchaseByToken(db, card.company, token)).toMatchObject({
      kind: "refund",
      status: "settled",
      settledUsdCents: 1500n,
    });
    expect(await cardExpensesOf(db, card.company)).toEqual([]);
    const totals = await balance();
    expect(totals.refunded).toBe(1500n);
    expect(totals.available).toBe(101_500n);
    const notified = await outboxOf(db, card.company, "card_refund_received");
    expect(notified.map((row) => row.channel).sort()).toEqual([
      "email",
      "push",
    ]);
  });

  it("leaves a credit still on its way alone until it settles", async () => {
    const token = newToken();
    await deliver(token, {
      status: "PENDING",
      hold: 1000,
      events: ["CREDIT_AUTHORIZATION"],
    });
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
    expect((await balance()).onHold).toBe(0n);
    expect(await outboxOf(db, card.company, "card_receipt_needed")).toEqual([]);
  });

  it("flags a purchase that changes after its Card expense, and leaves the expense", async () => {
    const token = newToken();
    await deliver(token, { status: "SETTLED", settlement: -2500 });
    const [expense] = await cardExpensesOf(db, card.company);
    const amountKes = expense?.amountKes;
    await deliver(token, { status: "SETTLED", settlement: -2800 });
    const purchase = await readPurchaseByToken(db, card.company, token);
    expect(purchase?.changedAfterExpenseAt).toBeInstanceOf(Date);
    expect(purchase?.settledUsdCents).toBe(2800n);
    const [unchanged] = await cardExpensesOf(db, card.company);
    expect(unchanged?.amountKes).toBe(amountKes);
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
  });

  it("makes one expense when two deliveries race", async () => {
    const token = newToken();
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: card.cardToken,
        status: "SETTLED",
        settlement: -2500,
      }),
    );
    // Both get past the "is an expense owed" check, then ask for the rate.
    paycrest.state.rateGate = barrier(2);
    const responses = await Promise.all([
      sendLithicEvent(app, transactionEvent(token)),
      sendLithicEvent(app, transactionEvent(token)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
  });

  it("warns the admins once a day when the Card balance runs low", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 96_000);
    await deliver(token, { hold: -96_000 });
    const low = await outboxOf(db, card.company, "card_balance_low");
    expect(low).toHaveLength(2);
    expect(low.map((row) => row.channel).sort()).toEqual(["email", "push"]);
    await deliver(token, { status: "SETTLED", settlement: -96_000 });
    expect(await outboxOf(db, card.company, "card_balance_low")).toHaveLength(
      2,
    );
  });

  it("answers 500 when the rate is down, and reconcile finishes the expense later", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 2500);
    paycrest.state.failRate = true;
    const response = await deliver(token, {
      status: "SETTLED",
      settlement: -2500,
    });
    expect(response.status).toBe(500);
    expect(await readPurchaseByToken(db, card.company, token)).toMatchObject({
      status: "settled",
      settledUsdCents: 2500n,
      expenseId: null,
    });
    expect(await cardExpensesOf(db, card.company)).toEqual([]);

    paycrest.state.failRate = false;
    await runtime.runPromise(reconcileCardPurchases(RECONCILE_EVERYTHING));
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.amountKes).toBe(321_700n);
    expect(
      (await readPurchaseByToken(db, card.company, token))?.expenseId,
    ).toBe(expense?.id);
  });

  it("reconcile sees a settled transaction the webhook never delivered", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 2500);
    lithic.state.transactions.set(
      token,
      fakeLithicTransaction({
        token,
        cardToken: card.cardToken,
        status: "SETTLED",
        settlement: -2500,
      }),
    );
    await runtime.runPromise(reconcileCardPurchases(RECONCILE_EVERYTHING));
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
    expect(
      await outboxOf(db, card.company, "card_receipt_needed"),
    ).toHaveLength(1);
  });

  it("carries on past a transaction Lithic can't find, and rotates it to the back", async () => {
    const lost = newToken();
    await authorize(app, card.cardToken, lost, 2500);
    const later = newToken();
    await authorize(app, card.cardToken, later, 1000);
    lithic.state.transactions.set(
      later,
      fakeLithicTransaction({
        token: later,
        cardToken: card.cardToken,
        status: "SETTLED",
        settlement: -1000,
      }),
    );
    const before = await readPurchaseByToken(db, card.company, lost);

    const run = await runtime.runPromise(
      reconcileCardPurchases(RECONCILE_EVERYTHING),
    );
    expect(run.failed).toBeGreaterThan(0);
    expect(await cardExpensesOf(db, card.company)).toHaveLength(1);
    const after = await readPurchaseByToken(db, card.company, lost);
    expect(after?.updatedAt.getTime()).toBeGreaterThan(
      before?.updatedAt.getTime() ?? 0,
    );
  });
});

describe("POST /webhooks/lithic/authorization", () => {
  it("refuses a bad signature and raises an ops alert", async () => {
    lithic.state.signaturesValid = false;
    const { status } = await authorize(app, card.cardToken, newToken(), 1000);
    expect(status).toBe(401);
    expect(await signatureFailures()).toBeGreaterThan(0);
  });

  it("declines more than the Card balance, and holds nothing", async () => {
    const token = newToken();
    const { body } = await authorize(app, card.cardToken, token, 100_001);
    expect(body).toEqual({ token, result: "INSUFFICIENT_FUNDS" });
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
  });

  it("can't overspend when two authorizations race", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        authorize(app, card.cardToken, newToken(), 60_000),
      ),
    );
    expect(
      results.filter(({ body }) => body.result === "APPROVED"),
    ).toHaveLength(1);
    const totals = await balance();
    expect(totals.onHold).toBe(60_000n);
    expect(totals.available).toBe(40_000n);
  });

  it("waits for a hold in flight instead of spending the same balance", async () => {
    const organizationId = card.company.organizationId;
    let pending: ReturnType<typeof authorize> | undefined;
    await runInScope(
      db,
      { organizationId, userId: card.company.admin.id },
      async (tx) => {
        // Stands in for another authorization holding the program lock.
        await tx.execute(
          sql`SELECT 1 FROM card_programs WHERE organization_id = ${organizationId} FOR UPDATE`,
        );
        pending = authorize(app, card.cardToken, newToken(), 95_000);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await tx.insert(cardPurchases).values({
          organizationId,
          cardId: card.cardId,
          membershipId: card.holderMembershipId,
          lithicTransactionToken: newToken(),
          status: "pending",
          merchant: "EARLIER HOLD",
          mcc: "5734",
          holdUsdCents: 95_000n,
          authorizedAt: new Date(),
          categoryId: card.categoryId,
        });
      },
    );
    if (!pending) throw new Error("authorization never started");
    expect((await pending).body.result).toBe("INSUFFICIENT_FUNDS");
  });

  it("holds once for a request Lithic delivers twice, even when the balance is gone", async () => {
    const token = newToken();
    const first = await authorize(app, card.cardToken, token, 90_000);
    const second = await authorize(app, card.cardToken, token, 90_000);
    expect(first.body).toEqual({ token, result: "APPROVED" });
    expect(second.body).toEqual({ token, result: "APPROVED" });
    expect((await balance()).onHold).toBe(90_000n);
  });

  it("declines an unknown card", async () => {
    const token = newToken();
    const { body } = await authorize(app, `card-${randomUUID()}`, token, 100);
    expect(body).toEqual({ token, result: "CARD_PAUSED" });
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
  });

  it("declines a card a leaver still holds", async () => {
    await runInScope(
      db,
      { organizationId: card.company.organizationId },
      (tx) => tx.execute(sqlCloseRequested(card.cardId)),
    );
    const token = newToken();
    const { body } = await authorize(app, card.cardToken, token, 100);
    expect(body).toEqual({ token, result: "CARD_PAUSED" });
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
  });

  it("answers a balance inquiry with the two balance fields", async () => {
    const hold = newToken();
    await authorize(app, card.cardToken, hold, 4000);
    const token = newToken();
    const { body } = await authorize(app, card.cardToken, token, 0, {
      status: "BALANCE_INQUIRY",
    });
    expect(body).toEqual({
      token,
      result: "APPROVED",
      balance: { amount: 100_000, available: 96_000 },
    });
    expect(await readPurchaseByToken(db, card.company, token)).toBeNull();
  });

  it("approves anything else it doesn't price, without holding", async () => {
    const token = newToken();
    const { body } = await authorize(app, card.cardToken, token, 500, {
      status: "CREDIT_AUTHORIZATION",
    });
    expect(body).toEqual({ token, result: "APPROVED" });
    expect((await balance()).onHold).toBe(0n);
  });
});

const sqlCloseRequested = (cardId: string) =>
  sql`UPDATE cards SET close_requested_at = now() WHERE id = ${cardId}`;

describe("reading Card purchases", () => {
  async function settledPurchase(cents = 2500) {
    const token = newToken();
    await authorize(app, card.cardToken, token, cents);
    await deliver(token, { status: "SETTLED", settlement: -cents });
    const purchase = await readPurchaseByToken(db, card.company, token);
    if (!purchase) throw new Error("no purchase");
    return purchase;
  }

  it("answers its contract, showing what's still needed", async () => {
    const purchase = await settledPurchase();
    const response = await memberRequest(
      card.holder,
      `cards/purchases/${purchase.id}`,
    );
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: unknown };
    const parsed = cardPurchaseSchema.parse(data);
    expect(parsed).toMatchObject({
      status: "settled",
      yours: true,
      amountKes: "321700",
      usdKesRate: "128.68",
      needsReceipt: true,
      changedAfterExpense: false,
      receiptCount: 0,
      category: { id: card.categoryId, name: "Software" },
      card: { nickname: "Subscriptions", lastFour: "4242" },
    });
  });

  it("gives admins and accountants every purchase, and employees their own", async () => {
    await settledPurchase();
    const other = await createUser(db);
    await addMember(db, card.company, other, { role: "employee" });
    const accountant = await createUser(db);
    await addMember(db, card.company, accountant, { role: "accountant" });

    const seenBy = async (user: { readonly privyUserId: string }) => {
      const response = await memberRequest(user, "cards/purchases");
      const { data } = (await response.json()) as { data: unknown };
      return cardPurchaseListSchema.parse(data).purchases.length;
    };
    expect(await seenBy(card.holder)).toBe(1);
    expect(await seenBy(other)).toBe(0);
    expect(await seenBy(card.company.admin)).toBe(1);
    expect(await seenBy(accountant)).toBe(1);
  });

  it("hides another employee's purchase behind NotFound", async () => {
    const purchase = await settledPurchase();
    const other = await createUser(db);
    await addMember(db, card.company, other, { role: "employee" });
    expect(
      (await memberRequest(other, `cards/purchases/${purchase.id}`)).status,
    ).toBe(404);
    const upload = await uploadReceipt(app, storage, card.company, other);
    expect(
      (
        await memberRequest(other, `cards/purchases/${purchase.id}/receipts`, {
          method: "POST",
          body: { receiptFileIds: [upload.receiptFileId] },
        })
      ).status,
    ).toBe(404);
  });

  it("refuses every write from an accountant", async () => {
    const purchase = await settledPurchase();
    const accountant = await createUser(db);
    await addMember(db, card.company, accountant, { role: "accountant" });
    const receipts = await memberRequest(
      accountant,
      `cards/purchases/${purchase.id}/receipts`,
      { method: "POST", body: { receiptFileIds: [randomUUID()] } },
    );
    expect(receipts.status).toBe(403);
    const waiver = await memberRequest(
      accountant,
      `cards/purchases/${purchase.id}/no-receipt`,
      { method: "POST", body: { reason: "Lost it at the airport." } },
    );
    expect(waiver.status).toBe(403);
  });

  it("pages newest first", async () => {
    for (const created of [
      "2026-11-01T10:00:00Z",
      "2026-11-02T10:00:00Z",
      "2026-11-03T10:00:00Z",
    ]) {
      await authorize(app, card.cardToken, newToken(), 100, { created });
    }
    const first = await memberRequest(
      card.company.admin,
      "cards/purchases?limit=2",
    );
    const page1 = cardPurchaseListSchema.parse(
      ((await first.json()) as { data: unknown }).data,
    );
    expect(page1.purchases.map((p) => p.authorizedAt.slice(0, 10))).toEqual([
      "2026-11-03",
      "2026-11-02",
    ]);
    const second = await memberRequest(
      card.company.admin,
      `cards/purchases?limit=2&cursor=${page1.nextCursor ?? ""}`,
    );
    const page2 = cardPurchaseListSchema.parse(
      ((await second.json()) as { data: unknown }).data,
    );
    expect(page2.purchases.map((p) => p.authorizedAt.slice(0, 10))).toEqual([
      "2026-11-01",
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  it("filters to what still needs a receipt", async () => {
    await settledPurchase();
    const declined = newToken();
    await deliver(declined, {
      status: "DECLINED",
      result: "DECLINED",
      detailedResults: ["CARD_PAUSED"],
    });
    const needing = cardPurchaseListSchema.parse(
      (
        (await (
          await memberRequest(
            card.company.admin,
            "cards/purchases?needsReceipt=true",
          )
        ).json()) as { data: unknown }
      ).data,
    );
    expect(needing.purchases).toHaveLength(1);
    expect(needing.purchases[0]?.status).toBe("settled");
  });
});

describe("receipts and waivers", () => {
  async function pendingPurchase(cents = 2500) {
    const token = newToken();
    await authorize(app, card.cardToken, token, cents);
    await deliver(token, { hold: -cents });
    const purchase = await readPurchaseByToken(db, card.company, token);
    if (!purchase) throw new Error("no purchase");
    return { token, purchase };
  }

  const settle = (token: string, cents = 2500) =>
    deliver(token, { status: "SETTLED", settlement: -cents });

  const attach = async (
    purchaseId: string,
    user: Parameters<typeof uploadReceipt>[3] = card.holder,
    extra: Record<string, unknown> = {},
  ) => {
    const upload = await uploadReceipt(app, storage, card.company, user);
    return {
      upload,
      response: await memberRequest(
        user,
        `cards/purchases/${purchaseId}/receipts`,
        {
          method: "POST",
          body: { receiptFileIds: [upload.receiptFileId], ...extra },
        },
      ),
    };
  };

  it("sends a settled purchase to Zoho once its receipt arrives, not before", async () => {
    await connectAccounting(db, card.company);
    const { token, purchase } = await pendingPurchase();
    await settle(token);
    const [expense] = await cardExpensesOf(db, card.company);
    expect(await accountingSyncsOf(db, card.company)).toEqual([]);

    const { response } = await attach(purchase.id);
    expect(response.status).toBe(200);
    const syncs = await accountingSyncsOf(db, card.company);
    expect(syncs.map((sync) => sync.subjectId)).toEqual([expense?.id]);
  });

  it("queues a receipt added before settling once the expense exists", async () => {
    await connectAccounting(db, card.company);
    const { token, purchase } = await pendingPurchase();
    const { upload, response } = await attach(purchase.id);
    expect(response.status).toBe(200);
    const body = cardPurchaseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(body).toMatchObject({ receiptCount: 1, needsReceipt: false });
    expect(await accountingSyncsOf(db, card.company)).toEqual([]);

    await settle(token);
    const [expense] = await cardExpensesOf(db, card.company);
    expect(await accountingSyncsOf(db, card.company)).toHaveLength(1);
    const [file] = await runInScope(
      db,
      { organizationId: card.company.organizationId },
      (tx) =>
        tx
          .select({ expenseId: receiptFiles.expenseId })
          .from(receiptFiles)
          .where(eq(receiptFiles.id, upload.receiptFileId)),
    );
    expect(file?.expenseId).toBe(expense?.id);
  });

  it("lets an admin waive the receipt only once the expense exists, then queues it", async () => {
    await connectAccounting(db, card.company);
    const { token, purchase } = await pendingPurchase();
    const reason = "Lost it at the airport.";
    const early = await memberRequest(
      card.company.admin,
      `cards/purchases/${purchase.id}/no-receipt`,
      { method: "POST", body: { reason } },
    );
    expect(early.status).toBe(400);

    await settle(token);
    const notAdmin = await memberRequest(
      card.holder,
      `cards/purchases/${purchase.id}/no-receipt`,
      { method: "POST", body: { reason } },
    );
    expect(notAdmin.status).toBe(403);

    const waived = await memberRequest(
      card.company.admin,
      `cards/purchases/${purchase.id}/no-receipt`,
      { method: "POST", body: { reason } },
    );
    expect(waived.status).toBe(200);
    const body = cardPurchaseSchema.parse(
      ((await waived.json()) as { data: unknown }).data,
    );
    expect(body).toMatchObject({
      noReceiptReason: reason,
      needsReceipt: false,
    });
    expect(await accountingSyncsOf(db, card.company)).toHaveLength(1);
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.noReceiptReason).toBe(reason);
  });

  it("refuses a receipt on a declined, voided or refunded purchase", async () => {
    for (const [status, extra] of [
      ["DECLINED", { result: "DECLINED", detailedResults: ["CARD_PAUSED"] }],
      ["VOIDED", {}],
      ["SETTLED", { settlement: 1000, events: ["RETURN"] }],
    ] as const) {
      const token = newToken();
      await authorize(app, card.cardToken, token, 2500);
      await deliver(token, { status, ...extra });
      const purchase = await readPurchaseByToken(db, card.company, token);
      if (!purchase) throw new Error("no purchase");
      const { response } = await attach(purchase.id);
      expect(response.status).toBe(400);
    }
  });

  it("only lets the uploader attach a pending file", async () => {
    const { purchase } = await pendingPurchase();
    const stranger = await createUser(db);
    await addMember(db, card.company, stranger, { role: "employee" });
    const upload = await uploadReceipt(app, storage, card.company, stranger);
    const response = await memberRequest(
      card.holder,
      `cards/purchases/${purchase.id}/receipts`,
      { method: "POST", body: { receiptFileIds: [upload.receiptFileId] } },
    );
    expect(response.status).toBe(400);
  });

  it("keeps a file on a purchase away from anything else", async () => {
    const { purchase } = await pendingPurchase();
    const { upload } = await attach(purchase.id);
    const other = await pendingPurchase(100);
    const onAnotherPurchase = await memberRequest(
      card.holder,
      `cards/purchases/${other.purchase.id}/receipts`,
      { method: "POST", body: { receiptFileIds: [upload.receiptFileId] } },
    );
    expect(onAnotherPurchase.status).toBe(400);

    const claim = await memberRequest(card.holder, "claims", {
      method: "POST",
      body: {
        merchant: "Java House",
        amountKes: "1,500.50",
        spentOn: "2026-10-15",
        description: "Lunch",
        categoryId: card.categoryId,
        receiptFileIds: [upload.receiptFileId],
      },
    });
    expect(claim.status).toBe(400);
  });

  it("adds a retried receipt once", async () => {
    const { purchase } = await pendingPurchase();
    const { upload } = await attach(purchase.id);
    const retry = await memberRequest(
      card.holder,
      `cards/purchases/${purchase.id}/receipts`,
      { method: "POST", body: { receiptFileIds: [upload.receiptFileId] } },
    );
    expect(retry.status).toBe(200);
    const body = cardPurchaseSchema.parse(
      ((await retry.json()) as { data: unknown }).data,
    );
    expect(body.receiptCount).toBe(1);
  });

  it("changes the category only with the first receipt", async () => {
    const travel = await addCategory(db, card.company, "Travel");
    const { token, purchase } = await pendingPurchase();
    const { response } = await attach(purchase.id, card.holder, {
      categoryId: travel,
    });
    expect(response.status).toBe(200);
    await settle(token);
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.categoryId).toBe(travel);

    const second = await attach(purchase.id, card.holder, {
      categoryId: card.categoryId,
    });
    expect(second.response.status).toBe(400);
  });

  it("changes the Card expense's category with an admin's waiver", async () => {
    const travel = await addCategory(db, card.company, "Travel");
    const { token, purchase } = await pendingPurchase();
    await settle(token);
    const waived = await memberRequest(
      card.company.admin,
      `cards/purchases/${purchase.id}/no-receipt`,
      {
        method: "POST",
        body: { reason: "Lost it at the airport.", categoryId: travel },
      },
    );
    expect(waived.status).toBe(200);
    const [expense] = await cardExpensesOf(db, card.company);
    expect(expense?.categoryId).toBe(travel);
    expect(
      (await readPurchaseByToken(db, card.company, token))?.categoryId,
    ).toBe(travel);
  });
});

describe("card receipt reminders", () => {
  const OVERDUE_CREATED = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const elevenInNairobi = (): Date => {
    const at = new Date();
    at.setUTCHours(8, 0, 0, 0);
    return at;
  };

  it("reminds about an old purchase with no receipt, once a day, and stops when it's done", async () => {
    const token = newToken();
    await authorize(app, card.cardToken, token, 2500, {
      created: OVERDUE_CREATED.toISOString(),
    });
    const fresh = newToken();
    await authorize(app, card.cardToken, fresh, 100);

    const at = elevenInNairobi();
    await runtime.runPromise(runCardReceiptReminders(at));
    expect(
      await outboxOf(db, card.company, "card_receipt_reminder"),
    ).toHaveLength(1);
    await runtime.runPromise(runCardReceiptReminders(at));
    expect(
      await outboxOf(db, card.company, "card_receipt_reminder"),
    ).toHaveLength(1);

    await deliver(token, { status: "VOIDED" });
    const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    await runtime.runPromise(runCardReceiptReminders(tomorrow));
    expect(
      await outboxOf(db, card.company, "card_receipt_reminder"),
    ).toHaveLength(1);
  });

  it("does nothing before the morning", async () => {
    const before = new Date();
    before.setUTCHours(2, 0, 0, 0);
    expect(
      await runtime.runPromise(runCardReceiptReminders(before)),
    ).toBeNull();
  });
});

describe("Card expenses alongside other spending", () => {
  async function recordedExpense() {
    const token = newToken();
    await authorize(app, card.cardToken, token, 2500);
    await deliver(token, { status: "SETTLED", settlement: -2500 });
    const [expense] = await cardExpensesOf(db, card.company);
    if (!expense) throw new Error("no expense");
    return { expense, token };
  }

  const getData = async (path: string) => {
    const response = await memberRequest(card.company.admin, path);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: never }).data;
  };

  it("counts in the overview's spending and its no-receipt list until complete", async () => {
    await recordedExpense();
    const data = (await getData("overview?month=2026-11")) as {
      outstanding: { noReceipt: { name: string }[] };
    };
    expect(data.outstanding.noReceipt.map((row) => row.name)).toEqual([
      "ACME SOFTWARE",
    ]);
  });

  it("leaves the no-receipt list once an admin has said why", async () => {
    const { token } = await recordedExpense();
    const purchase = await readPurchaseByToken(db, card.company, token);
    await memberRequest(
      card.company.admin,
      `cards/purchases/${purchase?.id ?? ""}/no-receipt`,
      { method: "POST", body: { reason: "Lost it at the airport." } },
    );
    const data = (await getData("overview?month=2026-11")) as {
      outstanding: { noReceipt: unknown[] };
    };
    expect(data.outstanding.noReceipt).toEqual([]);
  });

  it("lists with the company's expenses, keeping its own kind", async () => {
    const { expense } = await recordedExpense();
    const data = (await getData("expenses?kind=company")) as {
      expenses: { id: string; kind: string; listKind: string }[];
    };
    expect(data.expenses).toEqual([
      expect.objectContaining({
        id: expense.id,
        kind: "card",
        listKind: "company",
      }),
    ]);
  });

  it("appears in the month's report, named as a card in the preview", async () => {
    await recordedExpense();
    const summary = await runtime.runPromise(
      reportMonthSummary(
        { organizationId: card.company.organizationId, role: "admin" },
        "2026-11",
      ),
    );
    expect(summary.moneyOut.rows).toBe(1);
    expect(summary.moneyOut.totalKes).toBe("321700");
    expect(summary.moneyOut.preview[0]?.kind).toBe("card");
    expect(summary.receipts.expensesWithout).toBe(1);
  });
});
