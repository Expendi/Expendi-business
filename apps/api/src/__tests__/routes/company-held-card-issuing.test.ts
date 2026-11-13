import { eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CardActionRequest,
  CardActionResult,
  ExpendiCard,
} from "@expendi-business/shared";
import {
  cardActionResultSchema,
  cardConfirmationSchema,
  cardListSchema,
  expendiCardSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  bills,
  cardPrograms,
  cards,
  organizations,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import { lockPayingCard } from "../../services/recurring/paid-by-card.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeLithic,
  makeFakePaycrest,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const lithic = makeFakeLithic();
const paycrest = makeFakePaycrest();

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let company: TestCompany;
let admin: TestUser;
let adminPasskey: SoftwarePasskey;
let otherAdmin: TestUser;
let otherAdminPasskey: SoftwarePasskey;
let employee: TestUser;
let accountant: TestUser;
let categoryId: string;

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

const cardsPath = (rest = "") =>
  `/organizations/${company.organizationId}/cards${rest}`;

async function enrol(user: TestUser): Promise<SoftwarePasskey> {
  const passkey = SoftwarePasskey.create();
  const options = await runtime.runPromise(startPasskeyEnrolment(user.id));
  await runtime.runPromise(
    finishPasskeyEnrolment(user.id, passkey.register(options, TEST_ORIGIN)),
  );
  return passkey;
}

const startConfirmation = (
  user: Pick<TestUser, "privyUserId">,
  action: CardActionRequest,
) =>
  sendJson(app, cardsPath("/confirmations"), user, {
    method: "POST",
    body: action,
  });

async function confirm(
  user: Pick<TestUser, "privyUserId">,
  passkey: SoftwarePasskey,
  action: CardActionRequest,
): Promise<Response> {
  const started = await startConfirmation(user, action);
  expect(started.status, await started.clone().text()).toBe(201);
  const { data } = (await started.json()) as { data: unknown };
  const challenge = cardConfirmationSchema.parse(data);
  return sendJson(
    app,
    cardsPath(`/confirmations/${challenge.challengeId}`),
    user,
    {
      method: "POST",
      body: { action, response: passkey.sign(challenge.options, TEST_ORIGIN) },
    },
  );
}

async function resultOf(response: Response): Promise<CardActionResult> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { data } = (await response.json()) as { data: unknown };
  return cardActionResultSchema.parse(data);
}

async function errorOf(response: Response): Promise<string> {
  const { error } = (await response.clone().json()) as {
    error: { message: string };
  };
  return error.message;
}

const issueAction = (): CardActionRequest => ({
  type: "issue_company_card",
  nickname: "Software subscriptions",
  monthlyLimitUsd: "250",
  defaultCategoryId: categoryId,
});

async function issue(): Promise<ExpendiCard> {
  const result = await resultOf(
    await confirm(admin, adminPasskey, issueAction()),
  );
  if (result.type !== "issue_company_card") {
    throw new Error(`issued ${result.type}`);
  }
  return result.card;
}

const cardRow = async (cardId: string) => {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.select().from(cards).where(eq(cards.id, cardId)),
  );
  if (!row) throw new Error("card row not found");
  return row;
};

const auditOf = async (entityId: string) => {
  const { rows } = await owner.query<{ action: string; after: unknown }>(
    "SELECT action, after FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id",
    [entityId],
  );
  return rows;
};

const outboxKinds = async () => {
  const { rows } = await owner.query<{ kind: string }>(
    "SELECT kind FROM notification_outbox WHERE organization_id = $1",
    [company.organizationId],
  );
  return rows.map((row) => row.kind);
};

const asAdmin = () => ({
  organizationId: company.organizationId,
  userId: admin.id,
  role: "admin" as const,
});

/**
 * Until a session waits for a `cards` row, or a few seconds pass. Only a
 * waiter holds a tuple lock.
 */
async function waitForLockWait(pool: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'tuple' AND relation = 'cards'::regclass",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A recurring payment the card pays, by payee name. */
async function paymentOn(
  cardId: string,
  payeeName: string,
  values: { active?: boolean; nextDueOn?: string | null } = {},
): Promise<string> {
  const payeeId = await insertPayee(db, company, {
    kind: "vendor",
    name: payeeName,
  });
  return insertRecurringItem(db, company, {
    payeeId,
    categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: 20_000_000n,
    payVia: "card",
    cardId,
    ...values,
  });
}

/** A card-paid payment whose schedule ended on 15 March, its last bill still owed. */
async function lastBillOwedOn(
  cardId: string,
  payeeName: string,
): Promise<{ readonly itemId: string; readonly billId: string }> {
  const payeeId = await insertPayee(db, company, {
    kind: "vendor",
    name: payeeName,
  });
  const itemId = await insertRecurringItem(db, company, {
    payeeId,
    categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: 20_000_000n,
    payVia: "card",
    cardId,
    endsOn: "2026-03-15",
    nextDueOn: null,
  });
  const billId = await insertBill(db, company, {
    payeeId,
    categoryId,
    recurringItemId: itemId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: 20_000_000n,
    dueOn: "2026-03-15",
    status: "overdue",
  });
  return { itemId, billId };
}

beforeEach(async () => {
  lithic.state.reset();
  paycrest.state.reset();
  ({ company, passkey: adminPasskey } = await createPayingCompany(runtime, db));
  ({ admin } = company);
  categoryId = await addCategory(db, company, "Software");
  otherAdmin = await createUser(db);
  await addMember(db, company, otherAdmin, { role: "admin" });
  otherAdminPasskey = await enrol(otherAdmin);
  employee = await createUser(db);
  await addMember(db, company, employee);
  accountant = await createUser(db);
  await addMember(db, company, accountant, { role: "accountant" });

  const turnedOn = await sendJson(app, cardsPath("/program"), admin, {
    method: "POST",
    body: {
      legalName: "Twiga Foods Limited",
      kraPin: "P051234567X",
      addressLine1: "Waiyaki Way",
      city: "Nairobi",
      postalCode: "00100",
      phone: "+254700000001",
      contactFirstName: "Amina",
      contactLastName: "Otieno",
      contactEmail: "amina@twiga.example",
      contactPhone: "+254700000002",
    },
  });
  expect(turnedOn.status).toBe(201);
});

describe("issuing a company-held card", () => {
  it("creates it at Lithic on the company's own account, with nobody holding it", async () => {
    // #when
    const card = await issue();

    // #then
    const [program] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.select().from(cardPrograms),
    );
    const row = await cardRow(card.id);
    expect(card).toMatchObject({
      nickname: "Software subscriptions",
      companyHeld: true,
      holder: null,
      yours: false,
      monthlyLimitUsdCents: "25000",
      recurringPayments: [],
    });
    expect(row).toMatchObject({
      companyHeld: true,
      cardholderId: null,
      membershipId: null,
      issuedBy: admin.id,
    });
    expect([...lithic.state.cards.values()]).toEqual([
      expect.objectContaining({
        token: row.lithicCardToken,
        accountToken: program?.lithicAccountToken,
        memo: "Software subscriptions",
        monthlyLimitUsdCents: 25_000n,
      }),
    ]);
    expect(lithic.state.cardholders).toEqual([]);
    const [issued] = await auditOf(card.id);
    expect(issued).toMatchObject({
      action: "card.issued",
      after: { companyHeld: true, nickname: "Software subscriptions" },
    });
    expect(await outboxKinds()).not.toContain("card_issued");
  });

  it("is blocked by a pause, before the passkey and after", async () => {
    // #given a challenge started before the pause
    const action = issueAction();
    const started = await startConfirmation(admin, action);
    const { data } = (await started.json()) as { data: unknown };
    const challenge = cardConfirmationSchema.parse(data);
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, company.organizationId)),
    );

    // #when
    const before = await startConfirmation(admin, action);
    const after = await sendJson(
      app,
      cardsPath(`/confirmations/${challenge.challengeId}`),
      admin,
      {
        method: "POST",
        body: {
          action,
          response: adminPasskey.sign(challenge.options, TEST_ORIGIN),
        },
      },
    );

    // #then
    expect([before.status, after.status]).toEqual([409, 409]);
    expect(await errorOf(after)).toBe(
      "New cards are paused right now. Nothing was issued.",
    );
    expect(lithic.state.cards.size).toBe(0);
  });

  it("is for admins only", async () => {
    // #when
    const answers = await Promise.all(
      [employee, accountant].map((user) =>
        startConfirmation(user, issueAction()),
      ),
    );

    // #then
    expect(answers.map((response) => response.status)).toEqual([403, 403]);
  });
});

describe("managing a company-held card", () => {
  it("lets any admin freeze, unfreeze, lower and raise it", async () => {
    // #given
    const card = await issue();

    // #when
    const frozen = await sendJson(
      app,
      cardsPath(`/${card.id}/freeze`),
      otherAdmin,
      { method: "POST" },
    );
    const unfrozen = await resultOf(
      await confirm(otherAdmin, otherAdminPasskey, {
        type: "unfreeze_card",
        cardId: card.id,
      }),
    );
    const lowered = await sendJson(
      app,
      cardsPath(`/${card.id}/lower-limit`),
      otherAdmin,
      { method: "POST", body: { monthlyLimitUsd: "100" } },
    );
    const raised = await resultOf(
      await confirm(otherAdmin, otherAdminPasskey, {
        type: "raise_limit",
        cardId: card.id,
        monthlyLimitUsd: "300",
      }),
    );

    // #then
    expect([frozen.status, lowered.status]).toEqual([200, 200]);
    expect(unfrozen).toMatchObject({ card: { state: "open" } });
    expect(raised).toMatchObject({ card: { monthlyLimitUsdCents: "30000" } });
  });

  it("shows any admin its number with a fresh passkey", async () => {
    // #given
    const card = await issue();

    // #when
    const revealed = await resultOf(
      await confirm(otherAdmin, otherAdminPasskey, {
        type: "reveal_card",
        cardId: card.id,
      }),
    );

    // #then
    const row = await cardRow(card.id);
    expect(revealed).toMatchObject({ type: "reveal_card" });
    expect(lithic.state.embedSessions).toEqual([row.lithicCardToken]);
    expect((await auditOf(card.id)).map((entry) => entry.action)).toContain(
      "card.details_revealed",
    );
  });

  it("is out of an employee's and an accountant's reach", async () => {
    // #given
    const card = await issue();
    const reveal: CardActionRequest = { type: "reveal_card", cardId: card.id };

    // #when
    const answers = await Promise.all([
      startConfirmation(employee, reveal),
      startConfirmation(accountant, reveal),
      sendJson(app, cardsPath(`/${card.id}/freeze`), employee, {
        method: "POST",
      }),
      sendJson(app, cardsPath(`/${card.id}/freeze`), accountant, {
        method: "POST",
      }),
      sendJson(app, cardsPath(`/${card.id}/close`), accountant, {
        method: "POST",
      }),
      sendJson(app, cardsPath("?companyHeld=true"), employee),
    ]);

    // #then
    expect(answers.slice(0, 5).map((response) => response.status)).toEqual([
      404, 403, 404, 403, 403,
    ]);
    const { data } = (await answers[5].json()) as {
      data: unknown;
    };
    expect(cardListSchema.parse(data).cards).toEqual([]);
    expect(lithic.state.embedSessions).toEqual([]);
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("won't close while a recurring payment that hasn't ended uses it, paused or not", async () => {
    // #given
    const card = await issue();
    await paymentOn(card.id, "Anthropic");
    await paymentOn(card.id, "Vercel", { active: false });
    await paymentOn(card.id, "Notion");
    await paymentOn(card.id, "Linear", { nextDueOn: null });

    // #when
    const refused = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });

    // #then
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe(
      "This card still pays Anthropic, Vercel and Notion. Move its recurring payments to another card or another way of paying first.",
    );
    expect((await cardRow(card.id)).state).toBe("open");
    expect(lithic.state.updates).toEqual([]);
  });

  it("won't close while the last bill of a schedule that ended is still owed, and still lists that payment", async () => {
    // #given the schedule's last bill, created on its end date
    const card = await issue();
    const { itemId, billId } = await lastBillOwedOn(card.id, "Linear");

    // #when
    const refused = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });
    const listed = await sendJson(app, cardsPath(`/${card.id}`), admin);
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(bills)
        .set({
          status: "cancelled",
          cancelledReason: "Stopped using it",
          cancelledBy: admin.id,
          cancelledAt: new Date(),
        })
        .where(eq(bills.id, billId)),
    );
    const closed = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });

    // #then
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe(
      "Linear's last bill is still owed: pay it, mark it paid or cancel it first.",
    );
    const { data } = (await listed.json()) as { data: unknown };
    expect(expendiCardSchema.parse(data).recurringPayments).toEqual([
      { id: itemId, payeeName: "Linear", state: "active" },
    ]);
    expect(closed.status).toBe(200);
    expect((await cardRow(card.id)).state).toBe("closed");
  });

  it("says what to do about each payment that keeps it open: move the running ones, settle the ended ones' last bills", async () => {
    // #given
    const card = await issue();
    await paymentOn(card.id, "Anthropic");
    await lastBillOwedOn(card.id, "Linear");
    await paymentOn(card.id, "Vercel", { active: false });
    await lastBillOwedOn(card.id, "Notion");

    // #when
    const refused = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });

    // #then
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe(
      "This card still pays Anthropic and Vercel. Move its recurring payments to another card or another way of paying first. Linear's last bill is still owed: pay it, mark it paid or cancel it first. Notion's last bill is still owed: pay it, mark it paid or cancel it first.",
    );
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("can't be given a recurring payment once its closing has started, even when the card issuer fails to close it", async () => {
    // #given closing reaches Lithic, which fails
    const card = await issue();
    lithic.state.failUpdateCard = true;
    const failed = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });
    lithic.state.failUpdateCard = false;
    const payeeId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Anthropic",
      method: "outside",
    });

    // #when an admin then sets up a payment on it
    const assigned = await sendJson(
      app,
      `/organizations/${company.organizationId}/recurring-items`,
      admin,
      {
        method: "POST",
        body: {
          payeeId,
          amountUsd: "20",
          schedule: "monthly",
          scheduleDay: 11,
          startsOn: "2099-01-11",
          payVia: "card",
          cardId: card.id,
          overviewHeading: "subscriptions",
          categoryId,
        },
      },
    );

    // #then the close job is left to finish it
    expect(failed.status).toBe(503);
    expect(assigned.status).toBe(409);
    expect(await errorOf(assigned)).toBe(
      `Card •••• ${card.lastFour} is being closed. Pick another company-held card.`,
    );
    const row = await cardRow(card.id);
    expect(row.state).toBe("open");
    expect(row.closeRequestedAt).toBeInstanceOf(Date);
    const { rows: toClose } = await owner.query<{ card_id: string }>(
      "SELECT card_id FROM cards_to_close(10000)",
    );
    expect(toClose.map((each) => each.card_id)).toContain(card.id);
    expect((await auditOf(card.id)).map((entry) => entry.action)).toContain(
      "card.close_requested",
    );
  });

  it("waits for a payment being given to it, then refuses to close", async () => {
    // #given an admin's change holding the card to pay a new payment, not
    // yet committed
    const card = await issue();
    const payeeId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Anthropic",
    });
    let commit = (): void => undefined;
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const assigning = runInScope(db, asAdmin(), async (tx) => {
      await Effect.runPromise(
        lockPayingCard(tx, company.organizationId, card.id),
      );
      await tx.insert(recurringItems).values({
        organizationId: company.organizationId,
        payeeId,
        categoryId,
        overviewHeading: "subscriptions",
        currency: "usd",
        amountUsdc: 20_000_000n,
        schedule: "monthly",
        scheduleDay: 11,
        startsOn: "2026-01-01",
        nextDueOn: "2026-12-11",
        payVia: "card",
        cardId: card.id,
      });
      held();
      await committing;
    });
    await holding;

    // #when closing starts, and the change commits once it waits
    const closing = sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });
    await waitForLockWait(owner);
    commit();
    await assigning;
    const refused = await closing;

    // #then
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe(
      "This card still pays Anthropic. Move its recurring payments to another card or another way of paying first.",
    );
    expect(await cardRow(card.id)).toMatchObject({
      state: "open",
      closeRequestedAt: null,
    });
    expect(lithic.state.updates).toEqual([]);
  });

  it("closes once its recurring payments have moved or ended", async () => {
    // #given
    const card = await issue();
    const itemId = await paymentOn(card.id, "Anthropic");
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(recurringItems)
        .set({ nextDueOn: null })
        .where(eq(recurringItems.id, itemId)),
    );

    // #when
    const closed = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });

    // #then
    expect(closed.status).toBe(200);
    expect((await cardRow(card.id)).state).toBe("closed");
  });
});
