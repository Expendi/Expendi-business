import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateRecurringItemRequest,
  RecurringItem,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  recurringItemSchema,
  recurringItemsResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { bills, payees } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { assertBillPayable } from "../../services/bills/payable.js";
import { nairobiDate } from "../../services/bills/status.js";
import {
  insertBill,
  insertPayee,
  readBill,
  shiftDays,
} from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { addEmployeePayee, insertSalary } from "../helpers/payroll.js";
import {
  billsOfItem,
  insertRecurringItem,
  outstandingBillsOfItem,
  readRecurringItem,
} from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

let company: TestCompany;
let employee: TestUser;
let categoryId: string;
let supplierId: string;
let today: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  await addMember(db, company, employee);
  categoryId = await addCategory(db, company, "Rent");
  supplierId = await insertPayee(db, company, { name: "Landlord Ltd" });
  today = nairobiDate(new Date());
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/recurring-items`;

function send(
  method: string,
  path: string,
  body?: unknown,
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<Response> {
  return sendJson(app, path, user, { method, body });
}

async function dataOf<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const { data } = (await response.json()) as { data: unknown };
  return schema.parse(data);
}

const isoWeekday = (isoDate: string): number =>
  ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Weekly, with the first bill due 10 days from today and the next a week later. */
function itemRequest(
  overrides: Partial<CreateRecurringItemRequest> = {},
): CreateRecurringItemRequest {
  const startsOn = shiftDays(today, 10);
  return {
    payeeId: supplierId,
    amountKes: "45,000",
    schedule: "weekly",
    scheduleDay: isoWeekday(startsOn),
    startsOn,
    categoryId,
    ...overrides,
  };
}

async function createItem(
  overrides: Partial<CreateRecurringItemRequest> = {},
): Promise<RecurringItem> {
  const response = await send("POST", base(), itemRequest(overrides));
  if (response.status !== 201) {
    throw new Error(
      `create recurring item answered ${response.status}: ${await response.text()}`,
    );
  }
  return dataOf(response, recurringItemSchema);
}

async function act(
  item: RecurringItem,
  action: "pause" | "resume" | "end",
): Promise<Response> {
  return send("POST", `${base()}/${item.id}/${action}`);
}

async function getItem(itemId: string): Promise<RecurringItem> {
  return dataOf(await send("GET", `${base()}/${itemId}`), recurringItemSchema);
}

function nextBillOf(
  item: RecurringItem,
): NonNullable<RecurringItem["nextBill"]> {
  if (!item.nextBill) throw new Error(`item ${item.id} has no next bill`);
  return item.nextBill;
}

const billsPath = (billId: string) =>
  `/organizations/${company.organizationId}/bills/${billId}`;

function cancelBill(billId: string): Promise<Response> {
  return send("POST", `${billsPath(billId)}/cancel`, { reason: "Not needed" });
}

function markPaidOutside(billId: string): Promise<Response> {
  return send("POST", `${billsPath(billId)}/mark-paid-outside`, {
    paidOn: today,
  });
}

async function auditOf(entityType: string, entityId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_type: string;
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    "SELECT action, actor_type, actor_id, before, after FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY occurred_at",
    [entityType, entityId],
  );
  return rows;
}

describe("POST /organizations/:organizationId/recurring-items", () => {
  it("sets up a fixed weekly payment and creates its first bill", async () => {
    // #when
    const item = await createItem();

    // #then
    expect(item).toMatchObject({
      state: "active",
      payee: { id: supplierId, name: "Landlord Ltd", kind: "supplier" },
      overviewHeading: "transactions",
      category: { id: categoryId, name: "Rent" },
      variable: false,
      amountKes: "4500000",
      schedule: "weekly",
      startsOn: shiftDays(today, 10),
      endsOn: null,
      payVia: "expendi",
      reminderDays: 3,
      active: true,
      nextDueOn: shiftDays(today, 17),
      nextBill: {
        status: "upcoming",
        dueOn: shiftDays(today, 10),
        amountKes: "4500000",
      },
    });
  });

  it("gives the first bill the item's payee, heading, category and a link back", async () => {
    // #when
    const item = await createItem();

    // #then
    const bill = await readBill(db, company, nextBillOf(item).id);
    expect(bill).toMatchObject({
      payeeId: supplierId,
      recurringItemId: item.id,
      overviewHeading: "transactions",
      categoryId,
      variable: false,
      amountKes: 4_500_000n,
      dueOn: shiftDays(today, 10),
      status: "upcoming",
    });
  });

  it("starts a payment due today as due", async () => {
    // #when
    const item = await createItem({
      startsOn: today,
      scheduleDay: isoWeekday(today),
    });

    // #then
    expect(nextBillOf(item)).toMatchObject({ dueOn: today, status: "due" });
  });

  it("sets up a variable payment whose bills have no amount", async () => {
    // #when
    const item = await createItem({ variable: true, amountKes: null });

    // #then
    expect(item).toMatchObject({ variable: true, amountKes: null });
    const bill = await readBill(db, company, nextBillOf(item).id);
    expect([bill.variable, bill.amountKes]).toEqual([true, null]);
  });

  it("files a subscription vendor's payment under Subscriptions unless told otherwise", async () => {
    // #given
    const vendorId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Notion",
    });

    // #when
    const item = await createItem({ payeeId: vendorId });

    // #then
    expect(item.overviewHeading).toBe("subscriptions");
  });

  it("audits the new item as the admin and its first bill as the system", async () => {
    // #when
    const item = await createItem();

    // #then
    const [created] = await auditOf("recurring_item", item.id);
    expect(created).toMatchObject({
      action: "recurring_item.created",
      actor_type: "user",
      actor_id: company.admin.id,
      after: { amountKes: "4500000", schedule: "weekly", payVia: "expendi" },
    });
    expect(await auditOf("bill", nextBillOf(item).id)).toMatchObject([
      {
        action: "bill.created",
        actor_type: "system",
        actor_id: "recurring-bills",
        after: { recurringItemId: item.id, dueOn: shiftDays(today, 10) },
      },
    ]);
  });

  it("sets up a card-only subscription to be paid outside Expendi", async () => {
    // #given
    const cardOnlyId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Figma",
      method: "outside",
    });

    // #when
    const item = await createItem({ payeeId: cardOnlyId, payVia: "outside" });

    // #then
    expect(item.payVia).toBe("outside");
  });

  it("refuses to pay a payee who is paid outside Expendi through it", async () => {
    // #given
    const cardOnlyId = await insertPayee(db, company, {
      name: "Figma",
      method: "outside",
    });

    // #when
    const response = await send(
      "POST",
      base(),
      itemRequest({ payeeId: cardOnlyId, payVia: "expendi" }),
    );

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Figma is paid outside Expendi");
  });

  it.each<[string, () => Record<string, unknown>]>([
    ["a start date in the past", () => ({ startsOn: shiftDays(today, -1) })],
    ["a weekday past Sunday", () => ({ scheduleDay: 8 })],
    ["a day past the 31st", () => ({ schedule: "monthly", scheduleDay: 32 })],
    ["day 0", () => ({ schedule: "monthly", scheduleDay: 0 })],
    ["an end before the start", () => ({ endsOn: shiftDays(today, 9) })],
    [
      "no due date between the start and the end",
      () => ({
        endsOn: shiftDays(today, 10),
        scheduleDay: (isoWeekday(shiftDays(today, 10)) % 7) + 1,
      }),
    ],
    ["a fixed payment with no amount", () => ({ amountKes: null })],
    [
      "a variable payment with an amount",
      () => ({ variable: true, amountKes: "100" }),
    ],
    ["a salary heading", () => ({ overviewHeading: "salaries" })],
    ["a reminder 31 days ahead", () => ({ reminderDays: 31 })],
    ["an unknown schedule", () => ({ schedule: "daily" })],
  ])("refuses %s", async (_case, overrides) => {
    // #when
    const response = await send("POST", base(), {
      ...itemRequest(),
      ...overrides(),
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an archived payee", async () => {
    // #given
    const archivedId = await insertPayee(db, company, { archived: true });

    // #when
    const response = await send(
      "POST",
      base(),
      itemRequest({ payeeId: archivedId }),
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses a payee or category from another company", async () => {
    // #given
    const other = await createCompany(db);
    const theirPayee = await insertPayee(db, other);
    const theirCategory = await addCategory(db, other, "Rent");

    // #when
    const responses = await Promise.all([
      send("POST", base(), itemRequest({ payeeId: theirPayee })),
      send("POST", base(), itemRequest({ categoryId: theirCategory })),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([400, 400]);
  });
});

describe("GET /organizations/:organizationId/recurring-items", () => {
  it("lists active payments by next due date, then paused, then ended", async () => {
    // #given
    const later = await createItem({
      startsOn: shiftDays(today, 20),
      scheduleDay: isoWeekday(shiftDays(today, 20)),
    });
    const sooner = await createItem();
    const paused = await createItem();
    await act(paused, "pause");
    const ended = await createItem();
    await act(ended, "end");

    // #when
    const response = await send("GET", base());

    // #then
    expect(response.status).toBe(200);
    const items = await dataOf(response, recurringItemsResponseSchema);
    expect(items.map((item) => [item.id, item.state])).toEqual([
      [sooner.id, "active"],
      [later.id, "active"],
      [paused.id, "paused"],
      [ended.id, "ended"],
    ]);
  });

  it("returns one payment with its next bill", async () => {
    // #given
    const item = await createItem();

    // #when
    const fetched = await getItem(item.id);

    // #then
    expect(fetched).toEqual(item);
  });

  it("gives the next bill its own currency and amount", async () => {
    // #given
    const item = await createItem({ amountKes: "45,000" });

    // #when
    const fetched = await getItem(item.id);

    // #then
    expect(fetched.nextBill).toMatchObject({
      currency: "kes",
      amountKes: "4500000",
      amountUsdc: null,
    });
  });

  it("lists salaries too, unless asked to leave them to Payroll", async () => {
    // #given
    const person = await addEmployeePayee(db, company);
    const salaryId = await insertSalary(db, company, {
      payeeId: person.payeeId,
      categoryId,
    });
    const rent = await createItem();

    // #when
    const listed = async (query: string) =>
      (
        await dataOf(
          await send("GET", `${base()}${query}`),
          recurringItemsResponseSchema,
        )
      )
        .map((item) => item.id)
        .sort();
    const results = {
      everything: await listed(""),
      bills: await listed("?excludeSalaries=true"),
      explicit: await listed("?excludeSalaries=false"),
    };

    // #then
    expect(results).toEqual({
      everything: [salaryId, rent.id].sort(),
      bills: [rent.id],
      explicit: [salaryId, rent.id].sort(),
    });
  });

  it("shows an accountant the list without salaries, as an admin sees it", async () => {
    // #given
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    const person = await addEmployeePayee(db, company);
    await insertSalary(db, company, { payeeId: person.payeeId, categoryId });
    await createItem();

    // #when
    const read = (user: Pick<TestUser, "privyUserId">) =>
      send("GET", `${base()}?excludeSalaries=true`, undefined, user).then(
        (response) => dataOf(response, recurringItemsResponseSchema),
      );

    // #then
    expect(await read(accountant)).toEqual(await read(company.admin));
  });

  it("refuses an excludeSalaries that isn't true or false", async () => {
    // #when
    const response = await send("GET", `${base()}?excludeSalaries=yes`);

    // #then
    expect(response.status).toBe(400);
  });

  it.each(["not-a-uuid", randomUUID()])("answers 404 for %s", async (id) => {
    // #when
    const response = await send("GET", `${base()}/${id}`);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("PATCH /organizations/:organizationId/recurring-items/:itemId", () => {
  it("changes the amount of bills to come, and the current bill keeps its own", async () => {
    // #given
    const item = await createItem();
    const current = nextBillOf(item);

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      amountKes: "47,500",
    });

    // #then
    expect(response.status).toBe(200);
    expect((await readBill(db, company, current.id)).amountKes).toBe(
      4_500_000n,
    );
    await markPaidOutside(current.id);
    const next = nextBillOf(await getItem(item.id));
    expect(next.amountKes).toBe("4750000");
  });

  it("makes the payment variable, so the next bill has no amount", async () => {
    // #given
    const item = await createItem();

    // #when
    await send("PATCH", `${base()}/${item.id}`, { amountKes: null });
    await cancelBill(nextBillOf(item).id);

    // #then
    const after = await getItem(item.id);
    expect([after.variable, nextBillOf(after).amountKes]).toEqual([true, null]);
  });

  it("changes the category, heading and reminder, and audits before and after", async () => {
    // #given
    const item = await createItem();
    const utilities = await addCategory(db, company, "Utilities");

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      categoryId: utilities,
      overviewHeading: "subscriptions",
      reminderDays: 7,
    });

    // #then
    expect(await dataOf(response, recurringItemSchema)).toMatchObject({
      category: { id: utilities, name: "Utilities" },
      overviewHeading: "subscriptions",
      reminderDays: 7,
    });
    const entries = await auditOf("recurring_item", item.id);
    expect(entries.at(-1)).toMatchObject({
      action: "recurring_item.updated",
      actor_id: company.admin.id,
      before: { categoryId, overviewHeading: "transactions", reminderDays: 3 },
      after: {
        categoryId: utilities,
        overviewHeading: "subscriptions",
        reminderDays: 7,
      },
    });
  });

  it("ends the payment when the new end date is before its next due date, keeping its bill", async () => {
    // #given
    const item = await createItem();

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      endsOn: shiftDays(today, 12),
    });

    // #then
    const after = await dataOf(response, recurringItemSchema);
    expect(after).toMatchObject({
      state: "ended",
      endsOn: shiftDays(today, 12),
      nextDueOn: null,
      nextBill: { id: nextBillOf(item).id },
    });
  });

  it("keeps the next due date when the end date is exactly on it", async () => {
    // #given
    const item = await createItem();

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      endsOn: shiftDays(today, 17),
    });

    // #then
    expect(await dataOf(response, recurringItemSchema)).toMatchObject({
      state: "active",
      nextDueOn: shiftDays(today, 17),
    });
  });

  it("refuses an end date before the start", async () => {
    // #given
    const item = await createItem();

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      endsOn: shiftDays(today, 9),
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("writes no audit entry when nothing changes", async () => {
    // #given
    const item = await createItem();

    // #when
    await send("PATCH", `${base()}/${item.id}`, { reminderDays: 3 });

    // #then
    expect(
      (await auditOf("recurring_item", item.id)).map((entry) => entry.action),
    ).toEqual(["recurring_item.created"]);
  });

  it("refuses to change an ended payment", async () => {
    // #given
    const item = await createItem();
    await act(item, "end");

    // #when
    const response = await send("PATCH", `${base()}/${item.id}`, {
      reminderDays: 5,
    });

    // #then
    expect(response.status).toBe(409);
  });
});

describe("pausing, resuming and ending", () => {
  it("pausing stops the next bill, and the current bill stays", async () => {
    // #given
    const item = await createItem();
    const current = nextBillOf(item);

    // #when
    const paused = await dataOf(await act(item, "pause"), recurringItemSchema);
    await cancelBill(current.id);

    // #then
    expect(paused).toMatchObject({ state: "paused", active: false });
    expect(
      (await billsOfItem(db, company, item.id)).map((bill) => bill.status),
    ).toEqual(["cancelled"]);
  });

  it("resuming creates the next bill when there is none, skipping dates that passed", async () => {
    // #given
    const item = await createItem({
      startsOn: today,
      scheduleDay: isoWeekday(today),
    });
    await act(item, "pause");
    await cancelBill(nextBillOf(item).id);

    // #when
    const resumed = await dataOf(
      await act(item, "resume"),
      recurringItemSchema,
    );

    // #then
    expect(resumed).toMatchObject({
      state: "active",
      nextBill: { dueOn: shiftDays(today, 7), status: "upcoming" },
      nextDueOn: shiftDays(today, 14),
    });
  });

  it("resuming keeps the bill that stayed while paused", async () => {
    // #given
    const item = await createItem();
    await act(item, "pause");

    // #when
    const resumed = await dataOf(
      await act(item, "resume"),
      recurringItemSchema,
    );

    // #then
    expect(resumed.nextBill?.id).toBe(nextBillOf(item).id);
    expect(await outstandingBillsOfItem(db, company, item.id)).toHaveLength(1);
  });

  it("ending stops new bills for good, and the current bill stays", async () => {
    // #given
    const item = await createItem();
    const current = nextBillOf(item);

    // #when
    const ended = await dataOf(await act(item, "end"), recurringItemSchema);
    await markPaidOutside(current.id);

    // #then
    expect(ended).toMatchObject({
      state: "ended",
      nextDueOn: null,
      endsOn: shiftDays(today, 10),
    });
    expect(
      (await billsOfItem(db, company, item.id)).map((bill) => bill.status),
    ).toEqual(["paid_outside"]);
  });

  it("ending a payment already running sets its end date to today", async () => {
    // #given
    const item = await createItem({
      startsOn: today,
      scheduleDay: isoWeekday(today),
    });

    // #when
    const ended = await dataOf(await act(item, "end"), recurringItemSchema);

    // #then
    expect(ended.endsOn).toBe(today);
  });

  it.each([
    ["pause", "pause"],
    ["resume", null],
    ["end", "end"],
    ["pause", "end"],
    ["resume", "end"],
  ] as const)("refuses to %s a payment after %s", async (action, before) => {
    // #given
    const item = await createItem();
    if (before) await act(item, before);

    // #when
    const response = await act(item, action);

    // #then
    expect(response.status).toBe(409);
  });

  it("audits pausing, resuming and ending as the admin", async () => {
    // #given
    const item = await createItem();

    // #when
    await act(item, "pause");
    await act(item, "resume");
    await act(item, "end");

    // #then
    const entries = await auditOf("recurring_item", item.id);
    expect(entries.map((entry) => [entry.action, entry.actor_id])).toEqual([
      ["recurring_item.created", company.admin.id],
      ["recurring_item.paused", company.admin.id],
      ["recurring_item.resumed", company.admin.id],
      ["recurring_item.ended", company.admin.id],
    ]);
  });
});

describe("the next bill when the current one is settled", () => {
  it("marking a bill paid outside creates the next one, due on the next date", async () => {
    // #given
    const item = await createItem();

    // #when
    const response = await markPaidOutside(nextBillOf(item).id);

    // #then
    expect(response.status).toBe(200);
    const after = await getItem(item.id);
    expect(after).toMatchObject({
      nextBill: { dueOn: shiftDays(today, 17), status: "upcoming" },
      nextDueOn: shiftDays(today, 24),
    });
  });

  it("cancelling a bill creates the next one", async () => {
    // #given
    const item = await createItem();

    // #when
    await cancelBill(nextBillOf(item).id);

    // #then
    expect(nextBillOf(await getItem(item.id)).dueOn).toBe(shiftDays(today, 17));
  });

  it("creates the next bill once, however often the settlement is retried", async () => {
    // #given
    const item = await createItem();
    const current = nextBillOf(item).id;

    // #when
    const responses = await Promise.all([
      markPaidOutside(current),
      markPaidOutside(current),
      cancelBill(current),
    ]);

    // #then
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409, 409,
    ]);
    expect(await billsOfItem(db, company, item.id)).toHaveLength(2);
    expect(await outstandingBillsOfItem(db, company, item.id)).toHaveLength(1);
  });

  it("an overdue bill's successor is overdue too when its date has passed as well", async () => {
    // #given
    const payeeId = supplierId;
    const itemId = await insertRecurringItem(db, company, {
      payeeId,
      categoryId,
      schedule: "weekly",
      scheduleDay: isoWeekday(shiftDays(today, -14)),
      startsOn: shiftDays(today, -14),
      nextDueOn: shiftDays(today, -7),
    });
    const overdue = await insertBill(db, company, {
      payeeId,
      categoryId,
      recurringItemId: itemId,
      dueOn: shiftDays(today, -14),
      status: "overdue",
    });

    // #when
    await markPaidOutside(overdue);

    // #then
    const after = await getItem(itemId);
    expect(after).toMatchObject({
      nextBill: { dueOn: shiftDays(today, -7), status: "overdue" },
      nextDueOn: today,
    });
  });

  it("settling a one-off bill creates nothing", async () => {
    // #given
    const oneOff = await insertBill(db, company, {
      payeeId: supplierId,
      categoryId,
      dueOn: shiftDays(today, 3),
    });

    // #when
    const response = await cancelBill(oneOff);

    // #then
    expect(response.status).toBe(200);
    const { rows } = await owner.query(
      "SELECT 1 FROM bills WHERE organization_id = $1 AND recurring_item_id IS NOT NULL",
      [company.organizationId],
    );
    expect(rows).toEqual([]);
  });

  it("gives an archived payee no new bill", async () => {
    // #given
    const item = await createItem();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(payees)
        .set({ archived: true })
        .where(eq(payees.id, supplierId)),
    );

    // #when
    await cancelBill(nextBillOf(item).id);

    // #then
    expect(await outstandingBillsOfItem(db, company, item.id)).toEqual([]);
  });
});

describe("one bill still owed per recurring payment, in the database", () => {
  it.each(["upcoming", "due", "overdue"] as const)(
    "refuses a second bill while one is %s",
    async (status) => {
      // #given
      const item = await createItem();

      // #when
      const second = insertBill(db, company, {
        payeeId: supplierId,
        categoryId,
        recurringItemId: item.id,
        dueOn: shiftDays(today, 30),
        status,
      });

      // #then
      await expect(second).rejects.toThrow();
      expect(await outstandingBillsOfItem(db, company, item.id)).toHaveLength(
        1,
      );
    },
  );

  it("allows any number of settled bills next to the one still owed", async () => {
    // #given
    const item = await createItem();

    // #when
    for (const dueOn of [shiftDays(today, -21), shiftDays(today, -14)]) {
      await insertBill(db, company, {
        payeeId: supplierId,
        categoryId,
        recurringItemId: item.id,
        dueOn,
        status: "cancelled",
        cancelledReason: "Duplicate",
        cancelledBy: company.admin.id,
        cancelledAt: new Date(),
      });
    }

    // #then
    expect(await billsOfItem(db, company, item.id)).toHaveLength(3);
  });
});

describe("variable bills", () => {
  function recurringItemIdOf(bill: { recurringItemId: string | null }): string {
    if (bill.recurringItemId === null) throw new Error("not a recurring bill");
    return bill.recurringItemId;
  }

  async function payableCheck(billId: string) {
    const bill = await readBill(db, company, billId);
    const [payee] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.select().from(payees).where(eq(payees.id, bill.payeeId)),
    );
    if (!payee) throw new Error("payee missing");
    const recurringItem = await readRecurringItem(
      db,
      company,
      recurringItemIdOf(bill),
    );
    return Effect.runSync(
      Effect.either(assertBillPayable({ bill, payee, recurringItem })),
    );
  }

  const reasonOf = (result: Awaited<ReturnType<typeof payableCheck>>) =>
    Either.isLeft(result) ? result.left.reason : null;

  it("a statutory bill can be paid once its amount and reference are entered on the bill", async () => {
    // #given
    const kraId = await insertPayee(db, company, {
      kind: "statutory",
      name: "KRA PAYE",
    });
    const item = await createItem({
      payeeId: kraId,
      variable: true,
      amountKes: null,
    });
    const billId = nextBillOf(item).id;
    const before = reasonOf(await payableCheck(billId));

    // #when
    const amountOnly = await send("PATCH", billsPath(billId), {
      amountKes: "61,250",
    });
    const withoutReference = reasonOf(await payableCheck(billId));
    const withReference = await send("PATCH", billsPath(billId), {
      reference: "KRA202611000123",
    });

    // #then
    expect([amountOnly.status, withReference.status]).toEqual([200, 200]);
    expect([before, withoutReference]).toEqual(["no_amount", "no_reference"]);
    expect(await payableCheck(billId)).toEqual(
      Either.right({ currency: "kes", amountKes: 6_125_000n }),
    );
    expect(
      (await dataOf(withReference, billDetailSchema)).recurringItemId,
    ).toBe(item.id);
  });

  it("a payment set up as paid outside Expendi can't be paid through it", async () => {
    // #given
    const item = await createItem({ payVia: "outside" });

    // #when
    const result = await payableCheck(nextBillOf(item).id);

    // #then
    expect(reasonOf(result)).toBe("paid_outside_recurring");
  });
});

describe("admins only", () => {
  const routes = [
    ["GET", ""],
    ["GET", "/:id"],
    ["POST", ""],
    ["PATCH", "/:id"],
    ["POST", "/:id/pause"],
    ["POST", "/:id/resume"],
    ["POST", "/:id/end"],
  ] as const;

  it.each(routes)("an employee gets 403 from %s %s", async (method, path) => {
    // #given
    const item = await createItem();

    // #when
    const response = await send(
      method,
      `${base()}${path.replace(":id", item.id)}`,
      method === "GET" ? undefined : { ...itemRequest(), reminderDays: 5 },
      employee,
    );

    // #then
    expect(response.status).toBe(403);
    expect(await readRecurringItem(db, company, item.id)).toMatchObject({
      active: true,
      reminderDays: 3,
      nextDueOn: shiftDays(today, 17),
    });
  });

  it("hides recurring payments from an employee in the database too", async () => {
    // #given
    await createItem();

    // #when
    const seen = await runInScope(
      db,
      {
        organizationId: company.organizationId,
        userId: employee.id,
        role: "employee",
      },
      (tx) => tx.execute(sql`SELECT id FROM recurring_items`),
    );

    // #then
    expect(seen.rows).toEqual([]);
  });
});

describe("company isolation", () => {
  async function itemIn(target: TestCompany): Promise<string> {
    return insertRecurringItem(db, target, {
      payeeId: await insertPayee(db, target),
      categoryId: await addCategory(db, target, `Rent ${randomUUID()}`),
    });
  }

  it("keeps each company's recurring payments to itself in the database", async () => {
    // #given
    await itemIn(fixture.companyA);
    await itemIn(fixture.companyB);

    // #then
    await expectTableIsolation(
      fixture,
      "recurring_items",
      "organization_id",
      "admin",
    );
  });

  it.each([
    ["GET", ""],
    ["GET", "/:id"],
    ["POST", ""],
    ["PATCH", "/:id"],
    ["POST", "/:id/pause"],
    ["POST", "/:id/resume"],
    ["POST", "/:id/end"],
  ] as const)("%s %s refuses another company", async (method, path) => {
    // #given
    const itemId = await itemIn(fixture.companyA);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/recurring-items${path.replace(":id", itemId)}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      },
    }));
  });
});

describe("switching how a recurring payment is paid", () => {
  const tillPayee = () =>
    insertPayee(db, company, {
      name: "Kenya Power",
      method: "mpesa_till",
      tillNumber: "123456",
      accountName: "Kenya Power",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });

  async function variableOutsideBill() {
    const item = await createItem({
      payeeId: await tillPayee(),
      payVia: "outside",
      variable: true,
      amountKes: null,
    });
    return { item, billId: nextBillOf(item).id };
  }

  it("keeps a variable bill variable, with the amount entered on it", async () => {
    // #given
    const { item, billId } = await variableOutsideBill();
    const entered = await send("PATCH", billsPath(billId), {
      amountKes: "3,000",
    });
    expect(entered.status, await entered.clone().text()).toBe(200);

    // #when
    const switched = await send("PATCH", `${base()}/${item.id}`, {
      payVia: "expendi",
    });

    // #then
    expect(switched.status, await switched.clone().text()).toBe(200);
    expect(await readBill(db, company, billId)).toMatchObject({
      variable: true,
      amountKes: 300_000n,
    });
  });

  it("refuses to pay through Expendi a bill whose own amount one cash-out can't send", async () => {
    // #given a bill entered under a larger limit than today's
    const { item, billId } = await variableOutsideBill();
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx
          .update(bills)
          .set({ amountKes: 40_000_000n })
          .where(eq(bills.id, billId)),
    );

    // #when
    const switched = await send("PATCH", `${base()}/${item.id}`, {
      payVia: "expendi",
    });

    // #then
    expect(switched.status).toBe(400);
    const { error } = (await switched.json()) as {
      error: { message: string; details?: { field?: string } };
    };
    expect(error.message).toMatch(/^A single payment can send at most /);
    expect(error.details?.field).toBe("amountKes");
    expect((await getItem(item.id)).payVia).toBe("outside");
  });
});
