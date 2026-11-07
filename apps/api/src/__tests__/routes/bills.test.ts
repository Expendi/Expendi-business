import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  Bill,
  BillDetail,
  BillsSummary,
  BillStatus,
  CreateBillRequest,
  ReceiptUploadResponse,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  billsResponseSchema,
  billsSummarySchema,
  paidFromAccountSchema,
  receiptUploadResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts, payrollRuns } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import {
  insertBill,
  insertBillPayout,
  insertPayee,
  readBill,
  shiftDays,
} from "../helpers/bills.js";
import {
  addCategory,
  claimRequest,
  randomSha256,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { addEmployeePayee } from "../helpers/payroll.js";
import { insertRecurringItem } from "../helpers/recurring.js";
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
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  await addMember(db, company, employee);
  categoryId = await addCategory(db, company, "Utilities");
  supplierId = await insertPayee(db, company, { name: "Kenya Power" });
  today = nairobiDate(new Date());
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/bills`;

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

function billRequest(overrides: Partial<CreateBillRequest> = {}) {
  return {
    payeeId: supplierId,
    amountKes: "15,000.50",
    dueOn: shiftDays(today, 10),
    categoryId,
    reference: "INV-0042",
    ...overrides,
  } satisfies CreateBillRequest;
}

async function createBill(
  overrides: Partial<CreateBillRequest> = {},
): Promise<BillDetail> {
  const response = await send("POST", base(), billRequest(overrides));
  if (response.status !== 201) {
    throw new Error(
      `create bill answered ${response.status}: ${await response.text()}`,
    );
  }
  return dataOf(response, billDetailSchema);
}

async function auditOf(billId: string, action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    "SELECT actor_type, actor_id, before, after FROM audit_log WHERE entity_type = 'bill' AND entity_id = $1 AND action = $2 ORDER BY occurred_at",
    [billId, action],
  );
  return rows;
}

/** Asks the bills route for an upload URL, then "uploads" the file. */
async function uploadBillFile(
  contentType = "application/pdf",
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<ReceiptUploadResponse> {
  const body = { contentType, byteSize: 240_000, sha256: randomSha256() };
  const response = await send("POST", `${base()}/upload-url`, body, user);
  if (response.status !== 201) {
    throw new Error(`bills upload-url answered ${response.status}`);
  }
  const upload = await dataOf(response, receiptUploadResponseSchema);
  storage.state.put(upload.storageKey, body.byteSize, contentType);
  return upload;
}

describe("POST /organizations/:organizationId/bills", () => {
  it("creates a one-off bill with the amount in integer KES cents", async () => {
    // #when
    const bill = await createBill();

    // #then
    expect(bill).toMatchObject({
      status: "upcoming",
      payee: { id: supplierId, name: "Kenya Power", kind: "supplier" },
      overviewHeading: "transactions",
      category: { id: categoryId, name: "Utilities" },
      variable: false,
      amountKes: "1500050",
      reference: "INV-0042",
      notes: null,
      dueOn: shiftDays(today, 10),
      fileCount: 0,
      files: [],
    });
  });

  it.each([
    [1, "upcoming"],
    [0, "due"],
    [-1, "overdue"],
  ] as const)(
    "a bill due %i days from today in Nairobi starts %s",
    async (days, status) => {
      // #when
      const bill = await createBill({ dueOn: shiftDays(today, days) });

      // #then
      expect(bill.status).toBe(status);
    },
  );

  it("audits the new bill as the admin's action", async () => {
    // #when
    const bill = await createBill();

    // #then
    const [entry] = await auditOf(bill.id, "bill.created");
    expect(entry).toMatchObject({
      actor_type: "user",
      actor_id: company.admin.id,
      before: null,
      after: {
        payeeId: supplierId,
        amountKes: "1500050",
        status: "upcoming",
        variable: false,
      },
    });
  });

  it("files a subscription vendor's bill under Subscriptions unless told otherwise", async () => {
    // #given
    const vendorId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Notion",
    });

    // #when
    const defaulted = await createBill({ payeeId: vendorId });
    const chosen = await createBill({
      payeeId: vendorId,
      overviewHeading: "transactions",
    });

    // #then
    expect([defaulted.overviewHeading, chosen.overviewHeading]).toEqual([
      "subscriptions",
      "transactions",
    ]);
  });

  it("files a statutory payment under Transactions", async () => {
    // #given
    const kraId = await insertPayee(db, company, {
      kind: "statutory",
      name: "KRA PAYE",
    });

    // #when
    const bill = await createBill({
      payeeId: kraId,
      amountKes: undefined,
      variable: true,
    });

    // #then
    expect(bill.overviewHeading).toBe("transactions");
  });

  it("saves a variable bill without its amount", async () => {
    // #when
    const bill = await createBill({ variable: true, amountKes: undefined });

    // #then
    expect(bill).toMatchObject({ variable: true, amountKes: null });
  });

  it("gives a bill to a payee paid outside Expendi", async () => {
    // #given
    const cardOnlyId = await insertPayee(db, company, {
      kind: "vendor",
      name: "Figma",
      method: "outside",
    });

    // #when
    const bill = await createBill({ payeeId: cardOnlyId });

    // #then
    expect(bill.payee).toMatchObject({ id: cardOnlyId, method: "outside" });
  });

  it("attaches uploaded invoices, a PDF and a photo", async () => {
    // #given
    const pdf = await uploadBillFile("application/pdf");
    const photo = await uploadReceipt(app, storage, company, company.admin);

    // #when
    const bill = await createBill({
      invoiceFileIds: [pdf.receiptFileId, photo.receiptFileId],
    });

    // #then
    expect(
      bill.files.map(({ id, role, kind, contentType }) => ({
        id,
        role,
        kind,
        contentType,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: pdf.receiptFileId,
          role: "invoice",
          kind: "pdf",
          contentType: "application/pdf",
        },
        {
          id: photo.receiptFileId,
          role: "invoice",
          kind: "photo",
          contentType: "image/jpeg",
        },
      ]),
    );
  });

  it.each([
    [
      { amountKes: undefined },
      "Enter the amount, or mark the bill as variable.",
    ],
    [{ amountKes: "0" }, "above zero"],
    [{ amountKes: "1,500.505" }, "Enter the amount in KES"],
    [{ dueOn: "15/10/2026" }, "YYYY-MM-DD"],
    [{ overviewHeading: "salaries" }, "Transactions or Subscriptions"],
    [{ categoryId: "not-a-uuid" }, "Pick a category."],
  ] as const)("refuses %j", async (overrides, message) => {
    // #when
    const response = await send("POST", base(), {
      ...billRequest(),
      ...overrides,
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });

  it("refuses a payee from another company", async () => {
    // #given
    const elsewhere = await createCompany(db);
    const theirPayee = await insertPayee(db, elsewhere);

    // #when
    const response = await send(
      "POST",
      base(),
      billRequest({ payeeId: theirPayee }),
    );

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Pick one of the company's payees.",
    );
  });

  it("refuses a new bill for an archived payee", async () => {
    // #given
    const archivedId = await insertPayee(db, company, { archived: true });

    // #when
    const response = await send(
      "POST",
      base(),
      billRequest({ payeeId: archivedId }),
    );

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This payee is archived.");
  });

  it("refuses an archived category", async () => {
    // #given
    const archived = await addCategory(db, company, "Old", { archived: true });

    // #when
    const response = await send(
      "POST",
      base(),
      billRequest({ categoryId: archived }),
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an invoice someone else uploaded", async () => {
    // #given
    const theirs = await uploadReceipt(app, storage, company, employee);

    // #when
    const response = await send(
      "POST",
      base(),
      billRequest({ invoiceFileIds: [theirs.receiptFileId] }),
    );

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("That file isn't available.");
  });
});

describe("GET /organizations/:organizationId/bills", () => {
  async function list(query = ""): Promise<Bill[]> {
    const response = await send("GET", `${base()}${query}`);
    expect(response.status).toBe(200);
    return dataOf(response, billsResponseSchema);
  }

  it("lists bills by due date, earliest first", async () => {
    // #given
    const later = await createBill({ dueOn: shiftDays(today, 20) });
    const overdue = await createBill({ dueOn: shiftDays(today, -3) });
    const soon = await createBill({ dueOn: shiftDays(today, 2) });

    // #when
    const bills = await list();

    // #then
    expect(bills.map((bill) => bill.id)).toEqual([
      overdue.id,
      soon.id,
      later.id,
    ]);
  });

  it("filters by several statuses at once", async () => {
    // #given
    const overdue = await createBill({ dueOn: shiftDays(today, -3) });
    const due = await createBill({ dueOn: today });
    await createBill({ dueOn: shiftDays(today, 3) });

    // #when
    const bills = await list("?status=overdue,due");

    // #then
    expect(bills.map((bill) => bill.id)).toEqual([overdue.id, due.id]);
  });

  it("filters by heading, payee and due range", async () => {
    // #given
    const vendorId = await insertPayee(db, company, { kind: "vendor" });
    const match = await createBill({
      payeeId: vendorId,
      dueOn: shiftDays(today, 5),
    });
    await createBill({ payeeId: vendorId, dueOn: shiftDays(today, 40) });
    await createBill({ dueOn: shiftDays(today, 5) });

    // #when
    const bills = await list(
      `?heading=subscriptions&payeeId=${vendorId}&dueFrom=${today}&dueTo=${shiftDays(today, 30)}`,
    );

    // #then
    expect(bills.map((bill) => bill.id)).toEqual([match.id]);
  });

  it.each(["?status=late", "?dueFrom=yesterday", "?limit=0"])(
    "refuses the filter %s",
    async (query) => {
      // #when
      const response = await send("GET", `${base()}${query}`);

      // #then
      expect(response.status).toBe(400);
    },
  );

  it("returns one bill with links to its files", async () => {
    // #given
    const pdf = await uploadBillFile();
    const created = await createBill({ invoiceFileIds: [pdf.receiptFileId] });

    // #when
    const response = await send("GET", `${base()}/${created.id}`);

    // #then
    const bill = await dataOf(response, billDetailSchema);
    expect(bill.files[0]?.url).toContain(pdf.storageKey);
  });

  it.each(["not-a-uuid", randomUUID()])(
    "answers 404 for the bill %s",
    async (billId) => {
      // #when
      const response = await send("GET", `${base()}/${billId}`);

      // #then
      expect(response.status).toBe(404);
    },
  );
});

describe("PATCH /organizations/:organizationId/bills/:billId", () => {
  it("moves the due date and the status with it", async () => {
    // #given
    const bill = await createBill({ dueOn: shiftDays(today, 5) });

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      dueOn: shiftDays(today, -1),
    });

    // #then
    expect(await dataOf(response, billDetailSchema)).toMatchObject({
      dueOn: shiftDays(today, -1),
      status: "overdue",
    });
  });

  it("refuses to change a fixed amount without a reason", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      amountKes: "16,000",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Say why the amount changed.");
  });

  it("changes a fixed amount with a reason, and audits both amounts", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      amountKes: "16,000",
      adjustmentReason: "Late fee added",
    });

    // #then
    expect(await dataOf(response, billDetailSchema)).toMatchObject({
      amountKes: "1600000",
      adjustmentReason: "Late fee added",
    });
    expect(await auditOf(bill.id, "bill.updated")).toEqual([
      expect.objectContaining({
        actor_id: company.admin.id,
        before: { amountKes: "1500050", adjustmentReason: null },
        after: { amountKes: "1600000", adjustmentReason: "Late fee added" },
      }),
    ]);
  });

  it("enters a variable bill's amount without a reason", async () => {
    // #given
    const bill = await createBill({ variable: true, amountKes: undefined });

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      amountKes: "48,250",
      reference: "PRN2026110012345",
    });

    // #then
    expect(await dataOf(response, billDetailSchema)).toMatchObject({
      amountKes: "4825000",
      reference: "PRN2026110012345",
      adjustmentReason: null,
    });
  });

  it("clears a variable bill's amount", async () => {
    // #given
    const bill = await createBill({ variable: true, amountKes: "1,000" });

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      amountKes: null,
    });

    // #then
    expect((await dataOf(response, billDetailSchema)).amountKes).toBeNull();
  });

  it.each([
    [{ amountKes: null }, "A fixed bill needs an amount."],
    [
      { adjustmentReason: "Typo" },
      "Only give a reason when you change the amount.",
    ],
    [{ overviewHeading: "petty_cash" }, "Transactions or Subscriptions"],
  ] as const)("refuses %j on a fixed bill", async (changes, message) => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, changes);

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });

  it("writes no audit entry when nothing changes", async () => {
    // #given
    const bill = await createBill();

    // #when
    await send("PATCH", `${base()}/${bill.id}`, {
      reference: "INV-0042",
      dueOn: bill.dueOn,
    });

    // #then
    expect(await auditOf(bill.id, "bill.updated")).toEqual([]);
  });

  it("changes a bill whose payment failed, which stays failed", async () => {
    // #given
    const wallet = await createActiveWallet(db, company);
    const billId = await insertBill(db, company, {
      payeeId: supplierId,
      categoryId,
      status: "payout_failed",
      payoutId: await insertBillPayout(db, company, wallet.id),
    });

    // #when
    const response = await send("PATCH", `${base()}/${billId}`, {
      dueOn: shiftDays(today, 7),
    });

    // #then
    expect(await dataOf(response, billDetailSchema)).toMatchObject({
      dueOn: shiftDays(today, 7),
      status: "payout_failed",
    });
  });

  it("refuses to change a cancelled bill", async () => {
    // #given
    const bill = await createBill();
    await send("POST", `${base()}/${bill.id}/cancel`, { reason: "Duplicate" });

    // #when
    const response = await send("PATCH", `${base()}/${bill.id}`, {
      notes: "Too late",
    });

    // #then
    expect(response.status).toBe(409);
  });
});

describe("POST /organizations/:organizationId/bills/:billId/mark-paid-outside", () => {
  it("records who marked it, the day it was paid, the note and the proof", async () => {
    // #given
    const bill = await createBill({ dueOn: shiftDays(today, -2) });
    const proof = await uploadReceipt(app, storage, company, company.admin);

    // #when
    const response = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      {
        paidOn: shiftDays(today, -1),
        note: "Paid from the KCB account",
        receiptFileIds: [proof.receiptFileId],
      },
    );

    // #then
    const paid = await dataOf(response, billDetailSchema);
    expect(paid).toMatchObject({
      status: "paid_outside",
      paidOn: shiftDays(today, -1),
      paidOutsideNote: "Paid from the KCB account",
      markedPaidBy: { userId: company.admin.id, email: company.admin.email },
      files: [
        expect.objectContaining({ id: proof.receiptFileId, role: "proof" }),
      ],
    });
    expect(paid.paidAt).not.toBeNull();
  });

  it("audits the change with the status before and after", async () => {
    // #given
    const bill = await createBill({ dueOn: today });

    // #when
    await send("POST", `${base()}/${bill.id}/mark-paid-outside`, {
      paidOn: today,
    });

    // #then
    expect(await auditOf(bill.id, "bill.marked_paid_outside")).toEqual([
      expect.objectContaining({
        actor_type: "user",
        actor_id: company.admin.id,
        before: { status: "due" },
        after: expect.objectContaining({
          status: "paid_outside",
          paidOn: today,
          amountKes: "1500050",
          markedPaidBy: company.admin.id,
          proofFileIds: [],
        }) as unknown,
      }),
    ]);
  });

  it("marks a card-only subscription paid", async () => {
    // #given
    const cardOnlyId = await insertPayee(db, company, {
      kind: "vendor",
      method: "outside",
    });
    const bill = await createBill({ payeeId: cardOnlyId });

    // #when
    const response = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      { paidOn: today },
    );

    // #then
    expect((await dataOf(response, billDetailSchema)).status).toBe(
      "paid_outside",
    );
  });

  it("needs a variable bill's amount first", async () => {
    // #given
    const bill = await createBill({ variable: true, amountKes: undefined });

    // #when
    const response = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      { paidOn: today },
    );

    // #then
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Enter the bill's amount");
  });

  it("refuses a payment date in the future", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      { paidOn: shiftDays(today, 1) },
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses to mark a bill paid twice", async () => {
    // #given
    const bill = await createBill();
    await send("POST", `${base()}/${bill.id}/mark-paid-outside`, {
      paidOn: today,
    });

    // #when
    const response = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      { paidOn: today },
    );

    // #then
    expect(response.status).toBe(409);
    expect(await auditOf(bill.id, "bill.marked_paid_outside")).toHaveLength(1);
  });
});

describe("POST /organizations/:organizationId/bills/:billId/cancel", () => {
  it("records who cancelled it, when and why", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("POST", `${base()}/${bill.id}/cancel`, {
      reason: "  Subscription ended  ",
    });

    // #then
    const cancelled = await dataOf(response, billDetailSchema);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelledReason: "Subscription ended",
      cancelledBy: { userId: company.admin.id },
    });
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it("audits the cancellation with its reason", async () => {
    // #given
    const bill = await createBill({ dueOn: shiftDays(today, -4) });

    // #when
    await send("POST", `${base()}/${bill.id}/cancel`, { reason: "Duplicate" });

    // #then
    expect(await auditOf(bill.id, "bill.cancelled")).toEqual([
      expect.objectContaining({
        actor_id: company.admin.id,
        before: { status: "overdue" },
        after: expect.objectContaining({
          status: "cancelled",
          reason: "Duplicate",
          cancelledBy: company.admin.id,
        }) as unknown,
      }),
    ]);
  });

  it("needs a reason", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("POST", `${base()}/${bill.id}/cancel`, {
      reason: "   ",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Say why this bill won't be paid.");
  });

  it("refuses to cancel a bill already marked paid", async () => {
    // #given
    const bill = await createBill();
    await send("POST", `${base()}/${bill.id}/mark-paid-outside`, {
      paidOn: today,
    });

    // #when
    const response = await send("POST", `${base()}/${bill.id}/cancel`, {
      reason: "Changed my mind",
    });

    // #then
    expect(response.status).toBe(409);
    expect((await readBill(db, company, bill.id)).status).toBe("paid_outside");
  });
});

describe("invoices", () => {
  it("attaches an invoice to an existing bill, once", async () => {
    // #given
    const bill = await createBill();
    const pdf = await uploadBillFile();

    // #when
    await send("POST", `${base()}/${bill.id}/attachments`, {
      receiptFileIds: [pdf.receiptFileId],
    });
    const again = await send("POST", `${base()}/${bill.id}/attachments`, {
      receiptFileIds: [pdf.receiptFileId],
    });

    // #then
    expect((await dataOf(again, billDetailSchema)).fileCount).toBe(1);
    expect(await auditOf(bill.id, "bill.files_attached")).toEqual([
      expect.objectContaining({
        after: { role: "invoice", receiptFileIds: [pdf.receiptFileId] },
      }),
    ]);
  });

  it("signs a PDF upload into the company's folder", async () => {
    // #when
    const upload = await uploadBillFile("application/pdf");

    // #then
    expect(upload.storageKey).toMatch(
      new RegExp(
        `^org/${company.organizationId}/receipts/[0-9a-f-]{36}\\.pdf$`,
      ),
    );
  });

  it("refuses an invoice that didn't finish uploading", async () => {
    // #given
    const bill = await createBill();
    const response = await send("POST", `${base()}/upload-url`, {
      contentType: "application/pdf",
      byteSize: 240_000,
      sha256: randomSha256(),
    });
    const upload = await dataOf(response, receiptUploadResponseSchema);

    // #when
    const attach = await send("POST", `${base()}/${bill.id}/attachments`, {
      receiptFileIds: [upload.receiptFileId],
    });

    // #then
    expect(attach.status).toBe(400);
    expect(await attach.text()).toContain("didn't finish uploading");
  });

  it("refuses a file that is already on a claim", async () => {
    // #given
    const bill = await createBill();
    const receipt = await uploadReceipt(app, storage, company, company.admin);
    const claim = await send(
      "POST",
      `/organizations/${company.organizationId}/claims`,
      claimRequest({ receiptFileIds: [receipt.receiptFileId], categoryId }),
    );
    expect(claim.status).toBe(201);

    // #when
    const attach = await send("POST", `${base()}/${bill.id}/attachments`, {
      receiptFileIds: [receipt.receiptFileId],
    });

    // #then
    expect(attach.status).toBe(400);
  });

  it("keeps claims image-only: a bill's PDF can't go on a claim", async () => {
    // #given
    const pdf = await uploadBillFile("application/pdf");

    // #when
    const claim = await send(
      "POST",
      `/organizations/${company.organizationId}/claims`,
      claimRequest({ receiptFileIds: [pdf.receiptFileId], categoryId }),
    );

    // #then
    expect(claim.status).toBe(400);
    expect(await claim.text()).toContain("That receipt isn't available.");
  });

  it("refuses an upload that is neither an image nor a PDF", async () => {
    // #when
    const response = await send("POST", `${base()}/upload-url`, {
      contentType: "application/zip",
      byteSize: 1000,
      sha256: randomSha256(),
    });

    // #then
    expect(response.status).toBe(400);
  });
});

describe("admins only", () => {
  const routes = [
    ["GET", ""],
    ["GET", "/summary"],
    ["GET", "/:id"],
    ["POST", ""],
    ["POST", "/upload-url"],
    ["PATCH", "/:id"],
    ["POST", "/:id/attachments"],
    ["POST", "/:id/mark-paid-outside"],
    ["POST", "/:id/cancel"],
  ] as const;

  it.each(routes)("an employee gets 403 from %s %s", async (method, path) => {
    // #given
    const bill = await createBill();
    const upload = await uploadReceipt(app, storage, company, employee);

    // #when
    const response = await send(
      method,
      `${base()}${path.replace(":id", bill.id)}`,
      method === "GET"
        ? undefined
        : {
            ...billRequest(),
            contentType: "application/pdf",
            byteSize: 1000,
            sha256: randomSha256(),
            receiptFileIds: [upload.receiptFileId],
            paidOn: today,
            reason: "Not needed",
          },
      employee,
    );

    // #then
    expect(response.status).toBe(403);
    expect((await readBill(db, company, bill.id)).status).toBe("upcoming");
  });

  it("hides bills from an employee in the database too", async () => {
    // #given
    await createBill();
    const membershipScope = {
      organizationId: company.organizationId,
      userId: employee.id,
      role: "employee" as const,
    };

    // #when
    const seen = await runInScope(db, membershipScope, (tx) =>
      tx.execute(sql`SELECT id FROM bills`),
    );

    // #then
    expect(seen.rows).toEqual([]);
  });

  it("hides a bill's invoice from an employee in the database", async () => {
    // #given
    const pdf = await uploadBillFile();
    await createBill({ invoiceFileIds: [pdf.receiptFileId] });

    // #when
    const seen = await runInScope(
      db,
      {
        organizationId: company.organizationId,
        userId: employee.id,
        role: "employee",
      },
      (tx) =>
        tx.execute(
          sql`SELECT id FROM receipt_files WHERE id = ${pdf.receiptFileId}`,
        ),
    );

    // #then
    expect(seen.rows).toEqual([]);
  });
});

describe("company isolation", () => {
  async function billIn(target: TestCompany): Promise<string> {
    return insertBill(db, target, {
      payeeId: await insertPayee(db, target),
      categoryId: await addCategory(db, target, `Rent ${randomUUID()}`),
      dueOn: shiftDays(today, 3),
    });
  }

  it("keeps each company's bills to itself in the database", async () => {
    // #given
    await billIn(fixture.companyA);
    await billIn(fixture.companyB);

    // #then
    await expectTableIsolation(fixture, "bills", "organization_id", "admin");
  });

  it.each([
    ["GET", ""],
    ["GET", "/summary"],
    ["GET", "/:id"],
    ["POST", ""],
    ["POST", "/upload-url"],
    ["PATCH", "/:id"],
    ["POST", "/:id/attachments"],
    ["POST", "/:id/mark-paid-outside"],
    ["POST", "/:id/cancel"],
  ] as const)("%s %s refuses another company", async (method, path) => {
    // #given
    const billId = await billIn(fixture.companyA);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/bills${path.replace(":id", billId)}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      },
    }));
  });
});

const asAdmin = () => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

const walletIds = new Map<string, string>();

/** A payout of a bill, from the company's one wallet. */
async function billPayout(): Promise<string> {
  let walletId = walletIds.get(company.organizationId);
  if (walletId === undefined) {
    walletId = (await createActiveWallet(db, company)).id;
    walletIds.set(company.organizationId, walletId);
  }
  return insertBillPayout(db, company, walletId);
}

/**
 * A bill straight to the table, in any status, with what that status
 * needs: a payout once paid through Expendi, the day it was paid, who
 * cancelled it. One-off and KES 2,500 by default.
 */
async function billWith(
  status: BillStatus,
  values: Partial<Parameters<typeof insertBill>[2]> = {},
): Promise<string> {
  const throughExpendi = ["paying", "paid", "payout_failed"].includes(status);
  const paid = status === "paid" || status === "paid_outside";
  return insertBill(db, company, {
    payeeId: supplierId,
    categoryId,
    status,
    dueOn: shiftDays(today, status === "upcoming" ? 5 : -1),
    ...(throughExpendi && { payoutId: await billPayout() }),
    ...(paid && { paidOn: today, paidAt: new Date() }),
    ...(status === "paid_outside" && { markedPaidBy: company.admin.id }),
    ...(status === "cancelled" && {
      cancelledReason: "Not needed",
      cancelledBy: company.admin.id,
      cancelledAt: new Date(),
    }),
    ...values,
  });
}

let payDays = 0;

/** A salary in a payroll run of its own, which only Payroll shows. */
async function insertPayrollBill(status: BillStatus): Promise<string> {
  payDays += 1;
  const person = await addEmployeePayee(db, company);
  const [run] = await runInScope(db, asAdmin(), (tx) =>
    tx
      .insert(payrollRuns)
      .values({
        organizationId: company.organizationId,
        payDate: shiftDays(today, -payDays),
        totalKes: 6_000_000n,
        salariesKes: 6_000_000n,
        capKes: 7_200_000n,
      })
      .returning({ id: payrollRuns.id }),
  );
  if (!run) throw new Error("payroll run insert returned no row");
  return billWith(status, {
    payeeId: person.payeeId,
    payrollRunId: run.id,
    overviewHeading: "salaries",
    amountKes: 6_000_000n,
  });
}

async function addAccount(name: string): Promise<string> {
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/paid-from-accounts`,
    company.admin,
    { method: "POST", body: { name, kind: "bank" } },
  );
  if (response.status !== 201) {
    throw new Error(`add account answered ${response.status}`);
  }
  return (await dataOf(response, paidFromAccountSchema)).id;
}

describe("GET /organizations/:organizationId/bills, for the Bills page", () => {
  async function idsListed(query: string): Promise<string[]> {
    const response = await send("GET", `${base()}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await dataOf(response, billsResponseSchema))
      .map((bill) => bill.id)
      .sort();
  }

  it("lists each tab's statuses: to pay, being paid, and history", async () => {
    // #given
    const toPay = [
      await billWith("upcoming"),
      await billWith("due"),
      await billWith("overdue"),
      await billWith("payout_failed"),
    ];
    const paying = await billWith("paying");
    const history = [
      await billWith("paid"),
      await billWith("paid_outside"),
      await billWith("cancelled"),
    ];

    // #when
    const tabs = {
      open: await idsListed("?view=open"),
      paying: await idsListed("?view=paying"),
      history: await idsListed("?view=history"),
      overdueToPay: await idsListed("?view=open&status=overdue,paid"),
    };

    // #then
    expect(tabs).toEqual({
      open: [...toPay].sort(),
      paying: [paying],
      history: [...history].sort(),
      overdueToPay: [toPay[2]],
    });
  });

  it("filters by category, by how the payee is paid, and by source", async () => {
    // #given
    const rentId = await addCategory(db, company, "Rent");
    const tillPayeeId = await insertPayee(db, company, {
      method: "mpesa_till",
      tillNumber: "123456",
      accountName: "Mama Mboga",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const itemId = await insertRecurringItem(db, company, {
      payeeId: supplierId,
      categoryId,
    });
    const rent = await billWith("upcoming", { categoryId: rentId });
    const till = await billWith("upcoming", { payeeId: tillPayeeId });
    const recurring = await billWith("upcoming", { recurringItemId: itemId });

    // #when
    const results = {
      category: await idsListed(`?categoryId=${rentId}`),
      till: await idsListed("?method=mpesa_till"),
      noDetails: await idsListed("?method=none"),
      recurring: await idsListed("?source=recurring"),
      oneOff: await idsListed("?source=one_off"),
    };

    // #then
    expect(results).toEqual({
      category: [rent],
      till: [till],
      noDetails: [rent, recurring].sort(),
      recurring: [recurring],
      oneOff: [rent, till].sort(),
    });
  });

  it("lists salary bills unless asked to leave them to Payroll", async () => {
    // #given
    const salary = await insertPayrollBill("overdue");
    const supplier = await billWith("overdue");

    // #when
    const results = {
      everything: await idsListed(""),
      bills: await idsListed("?excludePayroll=true"),
      explicit: await idsListed("?excludePayroll=false"),
    };

    // #then
    expect(results).toEqual({
      everything: [salary, supplier].sort(),
      bills: [supplier],
      explicit: [salary, supplier].sort(),
    });
  });

  it("leaves out bills settled before settledFrom, and keeps every bill not settled", async () => {
    // #given
    await billWith("paid", {
      dueOn: shiftDays(today, -90),
      paidOn: shiftDays(today, -60),
    });
    const paidLater = await billWith("paid_outside", {
      dueOn: shiftDays(today, -90),
      paidOn: shiftDays(today, -10),
    });
    const cancelledToday = await billWith("cancelled", {
      dueOn: shiftDays(today, -90),
      cancelledAt: new Date(),
    });
    const overdueLongAgo = await billWith("overdue", {
      dueOn: shiftDays(today, -90),
    });

    // #when
    const listed = await idsListed(`?settledFrom=${shiftDays(today, -30)}`);

    // #then
    expect(listed).toEqual([paidLater, cancelledToday, overdueLongAgo].sort());
  });

  it("gives a recurring bill its payment's schedule and state, and a one-off bill none", async () => {
    // #given
    const itemId = await insertRecurringItem(db, company, {
      payeeId: supplierId,
      categoryId,
      scheduleDay: 31,
      startsOn: "2026-01-31",
      active: false,
    });
    const recurring = await billWith("upcoming", { recurringItemId: itemId });
    const oneOff = await billWith("upcoming");

    // #when
    const bills = await dataOf(await send("GET", base()), billsResponseSchema);

    // #then
    expect(
      Object.fromEntries(bills.map((bill) => [bill.id, bill.recurring])),
    ).toEqual({
      [recurring]: {
        id: itemId,
        state: "paused",
        schedule: "monthly",
        scheduleDay: 31,
        startsOn: "2026-01-31",
      },
      [oneOff]: null,
    });
  });

  it("shows the account a bill marked paid outside was paid from", async () => {
    // #given
    const accountId = await addAccount("KCB current account");
    const bill = await createBill({ dueOn: shiftDays(today, -2) });
    const unmarked = await createBill();
    const marked = await send(
      "POST",
      `${base()}/${bill.id}/mark-paid-outside`,
      { paidOn: today, paidFromAccountId: accountId },
    );
    expect(marked.status, await marked.clone().text()).toBe(200);

    // #when
    const bills = await dataOf(await send("GET", base()), billsResponseSchema);

    // #then
    expect(
      Object.fromEntries(bills.map((row) => [row.id, row.paidFromAccount])),
    ).toEqual({
      [bill.id]: { id: accountId, name: "KCB current account" },
      [unmarked.id]: null,
    });
  });

  it.each([
    "?view=late",
    "?method=cash",
    "?source=weekly",
    "?excludePayroll=yes",
    "?settledFrom=yesterday",
    "?categoryId=rent",
  ])("refuses the filter %s", async (query) => {
    // #when
    const response = await send("GET", `${base()}${query}`);

    // #then
    expect(response.status).toBe(400);
  });
});

describe("GET /organizations/:organizationId/bills/:billId, its payment", () => {
  it("says why its latest payment through Expendi failed", async () => {
    // #given
    const payoutId = await billPayout();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(payouts)
        .set({ failureReason: "The paybill didn't accept the account number." })
        .where(eq(payouts.id, payoutId)),
    );
    const billId = await billWith("payout_failed", { payoutId });

    // #when
    const response = await send("GET", `${base()}/${billId}`);

    // #then
    expect((await dataOf(response, billDetailSchema)).payout).toEqual({
      id: payoutId,
      status: "failed",
      failureReason: "The paybill didn't accept the account number.",
    });
  });

  it("has no payment when it was never paid through Expendi", async () => {
    // #given
    const bill = await createBill();

    // #when
    const response = await send("GET", `${base()}/${bill.id}`);

    // #then
    expect((await dataOf(response, billDetailSchema)).payout).toBeNull();
  });
});

describe("GET /organizations/:organizationId/bills/summary", () => {
  async function summary(
    query = "",
    user: Pick<TestUser, "privyUserId"> = company.admin,
  ): Promise<BillsSummary> {
    const response = await send(
      "GET",
      `${base()}/summary${query}`,
      undefined,
      user,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return dataOf(response, billsSummarySchema);
  }

  const none = { count: 0, totalKes: "0", totalUsdc: "0" };

  it("counts each tab, and totals what's still to pay in KES and in USD", async () => {
    // #given KES in cents, USD in USDC base units
    await billWith("upcoming", { amountKes: 1_000_000n });
    await billWith("upcoming", { variable: true, amountKes: null });
    await billWith("due", { amountKes: 250_000n });
    await billWith("due", {
      currency: "usd",
      amountKes: null,
      amountUsdc: 45_000_000n,
    });
    await billWith("overdue", { amountKes: 4_850_000n });
    await billWith("payout_failed", { amountKes: 410_000n });
    await billWith("paying", { amountKes: 9_900_000n });
    await billWith("paid", { paidOn: today });
    await billWith("cancelled", { cancelledAt: new Date() });

    // #when
    const result = await summary();

    // #then
    expect(result).toEqual({
      views: { open: 6, paying: 1, history: 2 },
      toPay: {
        count: 6,
        withoutAmount: 1,
        totalKes: "6510000",
        totalUsdc: "45000000",
      },
      overdue: { count: 1, totalKes: "4850000", totalUsdc: "0" },
      dueToday: { count: 2, totalKes: "250000", totalUsdc: "45000000" },
      payoutFailed: { count: 1, totalKes: "410000", totalUsdc: "0" },
    });
  });

  it("counts the tabs with the filters, and the cards over every bill still to pay", async () => {
    // #given
    const rentId = await addCategory(db, company, "Rent");
    await billWith("overdue", { categoryId: rentId, amountKes: 100_000n });
    await billWith("paid", { categoryId: rentId, paidOn: today });
    await billWith("overdue", { amountKes: 200_000n });
    await billWith("paying");

    // #when
    const filtered = await summary(`?categoryId=${rentId}`);

    // #then
    expect({ views: filtered.views, overdue: filtered.overdue }).toEqual({
      views: { open: 1, paying: 0, history: 1 },
      overdue: { count: 2, totalKes: "300000", totalUsdc: "0" },
    });
  });

  it("counts history only from settledFrom", async () => {
    // #given
    await billWith("paid", { paidOn: shiftDays(today, -200) });
    await billWith("paid", { paidOn: shiftDays(today, -5) });

    // #when
    const result = await summary(`?settledFrom=${shiftDays(today, -180)}`);

    // #then
    expect(result.views.history).toBe(1);
  });

  it("never counts salaries, which Payroll shows", async () => {
    // #given
    await insertPayrollBill("overdue");
    await insertPayrollBill("payout_failed");
    await insertPayrollBill("paying");

    // #when
    const result = await summary();

    // #then
    expect(result).toEqual({
      views: { open: 0, paying: 0, history: 0 },
      toPay: { ...none, withoutAmount: 0 },
      overdue: none,
      dueToday: none,
      payoutFailed: none,
    });
  });

  it("shows an accountant what an admin sees", async () => {
    // #given
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    await billWith("overdue");

    // #when
    const asAccountant = await summary("", accountant);

    // #then
    expect(asAccountant).toEqual(await summary());
  });

  it.each(["?method=cash", "?settledFrom=soon", "?payeeId=kplc"])(
    "refuses the filter %s",
    async (query) => {
      // #when
      const response = await send("GET", `${base()}/summary${query}`);

      // #then
      expect(response.status).toBe(400);
    },
  );
});
