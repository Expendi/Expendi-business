import type { SQL } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CompanySpending,
  CompanySpendingDetail,
  ExpenseStatus,
  RecordCompanySpendingRequest,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  companySpendingDetailSchema,
  companySpendingPageSchema,
  duplicateOfSchema,
  paidFromAccountSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, paidFromAccounts } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { recordBillSpending } from "../../services/expenses/company.js";
import { nairobiToday } from "../../services/expenses/rules.js";
import {
  insertBill,
  insertPayee,
  readBill,
  shiftDays,
} from "../helpers/bills.js";
import {
  addCategory,
  buyGoodsSms,
  claimRequest,
  pasteSms,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  makeFakeFileStorage,
  makeFakeReceiptExtractor,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { billsOfItem, insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
const extractor = makeFakeReceiptExtractor();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

let company: TestCompany;
let employee: TestUser;
let employeeMembershipId: string;
let utilitiesId: string;
let softwareId: string;
let kcbId: string;
let cardId: string;

const TODAY = nairobiToday();
const D = shiftDays(TODAY, -10);
const ETIMS_QR =
  "https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00ABCDEF0123456789";

beforeAll(async () => {
  runtime = makeTestRuntime({
    fileStorage: storage.layer,
    receiptExtractor: extractor.layer,
  });
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
  extractor.state.reset();
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  employeeMembershipId = await addMember(db, company, employee);
  utilitiesId = await addCategory(db, company, "Utilities");
  softwareId = await addCategory(db, company, "Software");
  kcbId = await addAccount(company, "KCB current account", "bank");
  cardId = await addAccount(company, "Founder's Visa card", "card");
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/company-spending`;

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

async function addAccount(
  target: TestCompany,
  name: string,
  kind: "bank" | "card" | "cash",
): Promise<string> {
  const response = await sendJson(
    app,
    `/organizations/${target.organizationId}/paid-from-accounts`,
    target.admin,
    { method: "POST", body: { name, kind } },
  );
  if (response.status !== 201) {
    throw new Error(`add account answered ${response.status}`);
  }
  return (await dataOf(response, paidFromAccountSchema)).id;
}

function spendingRequest(
  overrides: Partial<RecordCompanySpendingRequest> = {},
): RecordCompanySpendingRequest {
  return {
    merchant: "Kenya Power",
    amountKes: "4,500.00",
    spentOn: D,
    categoryId: utilitiesId,
    description: "October electricity",
    paidFromAccountId: kcbId,
    ...overrides,
  };
}

async function recordWith(
  overrides: Partial<RecordCompanySpendingRequest> = {},
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<Response> {
  return send("POST", base(), spendingRequest(overrides), user);
}

async function recordWithPhoto(
  overrides: Partial<RecordCompanySpendingRequest> = {},
): Promise<CompanySpendingDetail> {
  const photo = await uploadReceipt(app, storage, company, company.admin);
  const response = await recordWith({
    receiptFileIds: [photo.receiptFileId],
    ...overrides,
  });
  if (response.status !== 201) {
    throw new Error(
      `record spending answered ${response.status}: ${await response.text()}`,
    );
  }
  return dataOf(response, companySpendingDetailSchema);
}

async function conflictOf(response: Response) {
  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    error: { message: string; details?: { duplicateOf?: unknown } };
  };
  return {
    message: body.error.message,
    duplicateOf: duplicateOfSchema.parse(body.error.details?.duplicateOf),
  };
}

async function auditOf(expenseId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    "SELECT action, actor_id, before, after FROM audit_log WHERE entity_type = 'expense' AND entity_id = $1 ORDER BY occurred_at",
    [expenseId],
  );
  return rows;
}

/** Row-level security applies to the owner role too, so read as the company's admin. */
async function asAdmin<T extends Record<string, unknown>>(statement: SQL) {
  const { rows } = await runInScope(
    db,
    {
      organizationId: company.organizationId,
      userId: company.admin.id,
      role: "admin",
    },
    (tx) => tx.execute<T>(statement),
  );
  return rows;
}

const spendingOfBill = (billId: string) =>
  asAdmin<{ id: string }>(
    sql`SELECT id FROM expenses WHERE bill_id = ${billId}`,
  );

async function listSpending(query = ""): Promise<CompanySpending[]> {
  const response = await send("GET", `${base()}${query}`);
  expect(response.status).toBe(200);
  return (await dataOf(response, companySpendingPageSchema)).spending;
}

const randomCode = (): string =>
  `S${randomBytes(5).toString("hex").slice(0, 9).toUpperCase()}`;

/** History as the spreadsheet import (T25) will write it. */
async function importClaim(values: {
  amountKes: bigint;
  spentOn: string;
  mpesaCode: string;
}): Promise<string> {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .insert(expenses)
        .values({
          organizationId: company.organizationId,
          membershipId: employeeMembershipId,
          kind: "claim",
          overviewHeading: "petty_cash",
          categoryId: utilitiesId,
          merchant: "Imported merchant",
          amountKes: values.amountKes,
          spentOn: values.spentOn,
          description: null,
          source: "import",
          status: "paid_outside" satisfies ExpenseStatus,
          mpesaCode: values.mpesaCode,
        })
        .returning({ id: expenses.id }),
  );
  if (!row) throw new Error("import insert returned no row");
  return row.id;
}

describe("POST /organizations/:organizationId/company-spending", () => {
  it("records spending with a photo: company kind, recorded, under Transactions, from its account", async () => {
    // #when
    const spending = await recordWithPhoto();

    // #then
    expect(spending).toMatchObject({
      status: "recorded",
      overviewHeading: "transactions",
      merchant: "Kenya Power",
      amountKes: "450000",
      spentOn: D,
      category: { id: utilitiesId, name: "Utilities" },
      paidFromAccount: {
        id: kcbId,
        name: "KCB current account",
        kind: "bank",
        archived: false,
      },
      bill: null,
      noReceipt: false,
      noReceiptReason: null,
      receiptCount: 1,
      recordedBy: {
        membershipId: company.adminMembershipId,
        email: company.admin.email,
      },
      receipts: [expect.objectContaining({ kind: "photo", billRole: null })],
    });
    const rows = await asAdmin<{
      kind: string;
      status: string;
      uploaded_by: string;
    }>(
      sql`SELECT e.kind, e.status, r.uploaded_by FROM expenses e JOIN receipt_files r ON r.expense_id = e.id WHERE e.id = ${spending.id}`,
    );
    expect(rows).toEqual([
      { kind: "company", status: "recorded", uploaded_by: company.admin.id },
    ]);
  });

  it("files it under the heading the admin picks", async () => {
    // #when
    const spending = await recordWithPhoto({
      overviewHeading: "subscriptions",
      categoryId: softwareId,
    });

    // #then
    expect(spending.overviewHeading).toBe("subscriptions");
  });

  it("audits the record as the admin's action", async () => {
    // #when
    const spending = await recordWithPhoto();

    // #then
    expect(await auditOf(spending.id)).toEqual([
      expect.objectContaining({
        action: "expense.recorded",
        actor_id: company.admin.id,
        after: expect.objectContaining({
          kind: "company",
          status: "recorded",
          amountKes: "450000",
          paidFromAccountId: kcbId,
          overviewHeading: "transactions",
        }) as unknown,
      }),
    ]);
  });

  it("takes the M-Pesa code from a pasted SMS, which must agree with the amount", async () => {
    // #given
    const code = randomCode();
    const sms = await pasteSms(
      app,
      company,
      company.admin,
      buyGoodsSms({ code, amount: "4,500.00", date: "20/10/26" }),
    );

    // #when
    const response = await recordWith({ receiptFileIds: [sms.receiptFileId] });

    // #then
    const spending = await dataOf(response, companySpendingDetailSchema);
    expect(spending.mpesaCode).toBe(code);
    expect(spending.receipts).toEqual([
      expect.objectContaining({ kind: "sms_text", billRole: null }),
    ]);
  });

  it("refuses an amount the pasted SMS contradicts", async () => {
    // #given
    const sms = await pasteSms(
      app,
      company,
      company.admin,
      buyGoodsSms({ code: randomCode(), amount: "1,000.00" }),
    );

    // #when
    const response = await recordWith({ receiptFileIds: [sms.receiptFileId] });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("doesn't match the SMS");
  });

  it("keeps a scanned eTIMS QR and the supplier's PIN it carries", async () => {
    // #when
    const spending = await recordWithPhoto({
      etimsQrPayload: ETIMS_QR,
      etimsInvoiceNumber: "KRACU0100000001/123",
    });

    // #then
    expect(spending).toMatchObject({
      etimsQrPayload: ETIMS_QR,
      etimsSupplierPin: "P051234567X",
      etimsInvoiceNumber: "KRACU0100000001/123",
      etimsStatus: "attached",
    });
  });

  it("keeps what reading the receipt returned with the spending", async () => {
    // #given
    const photo = await uploadReceipt(app, storage, company, company.admin);
    const read = await send(
      "POST",
      `/organizations/${company.organizationId}/receipts/${photo.receiptFileId}/extract`,
    );
    expect(read.status).toBe(200);

    // #when
    const response = await recordWith({
      receiptFileIds: [photo.receiptFileId],
    });

    // #then
    const spending = await dataOf(response, companySpendingDetailSchema);
    const rows = await asAdmin<{ extraction: unknown }>(
      sql`SELECT extraction FROM expenses WHERE id = ${spending.id}`,
    );
    expect(rows[0]?.extraction).toEqual({
      receipts: [
        expect.objectContaining({ receiptFileId: photo.receiptFileId }),
      ],
    });
  });

  it("saves without a receipt when the admin says why, flagged no receipt", async () => {
    // #when
    const response = await recordWith({
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    expect(response.status).toBe(201);
    const spending = await dataOf(response, companySpendingDetailSchema);
    expect(spending).toMatchObject({
      noReceipt: true,
      noReceiptReason: "Bank charge, no receipt issued",
      receiptCount: 0,
      receipts: [],
    });
    const [listed] = await listSpending();
    expect(listed).toMatchObject({ id: spending.id, noReceipt: true });
  });

  it("refuses spending with no receipt and no reason", async () => {
    // #when
    const response = await recordWith();

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("say why there isn't one");
    expect(await listSpending()).toEqual([]);
  });

  it("refuses a reason that says nothing", async () => {
    // #when
    const response = await recordWith({ noReceiptReason: "n/a" });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses a no-receipt reason alongside a receipt", async () => {
    // #given
    const photo = await uploadReceipt(app, storage, company, company.admin);

    // #when
    const response = await recordWith({
      receiptFileIds: [photo.receiptFileId],
      noReceiptReason: "Lost the paper copy",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses another company's paid-from account", async () => {
    // #given
    const other = await createCompany(db);
    const theirs = await addAccount(other, "Their bank", "bank");

    // #when
    const response = await recordWith({
      paidFromAccountId: theirs,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("paid-from accounts");
    expect(await listSpending()).toEqual([]);
  });

  it("refuses an archived paid-from account", async () => {
    // #given
    await send(
      "POST",
      `/organizations/${company.organizationId}/paid-from-accounts/${cardId}/archive`,
    );

    // #when
    const response = await recordWith({
      paidFromAccountId: cardId,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("needs the account it was paid from", async () => {
    // #when
    const response = await send("POST", base(), {
      ...spendingRequest(),
      paidFromAccountId: undefined,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Pick the account");
  });

  it("refuses a date in the future", async () => {
    // #when
    const response = await recordWith({
      spentOn: shiftDays(TODAY, 1),
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    expect(response.status).toBe(400);
  });
});

describe("the claim rules apply to company spending", () => {
  it("blocks an M-Pesa code already on an employee's claim, naming the claim", async () => {
    // #given
    const code = randomCode();
    const receipt = await uploadReceipt(app, storage, company, employee);
    const claimResponse = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [receipt.receiptFileId],
          categoryId: utilitiesId,
          mpesaCode: code,
          spentOn: D,
        }),
      },
    );
    expect(claimResponse.status).toBe(201);
    const { data: claim } = (await claimResponse.json()) as {
      data: { id: string };
    };

    // #when
    const response = await recordWith({
      mpesaCode: code,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.message).toContain("another employee's claim");
    expect(conflict.duplicateOf).toMatchObject({
      expenseId: claim.id,
      kind: "claim",
      yours: false,
    });
  });

  it("blocks an M-Pesa code from imported history", async () => {
    // #given
    const code = randomCode();
    await importClaim({ amountKes: 99_900n, spentOn: D, mpesaCode: code });

    // #when
    const response = await recordWith({
      mpesaCode: code,
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.message).toContain("(from the spreadsheet)");
  });

  it("blocks an eTIMS invoice number already on other company spending", async () => {
    // #given
    const earlier = await recordWithPhoto({
      etimsInvoiceNumber: "KRACU0100000001/777",
    });

    // #when
    const response = await recordWith({
      etimsInvoiceNumber: "KRACU0100000001/777",
      noReceiptReason: "Bank charge, no receipt issued",
    });

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.duplicateOf).toMatchObject({
      expenseId: earlier.id,
      kind: "company",
      yours: true,
    });
  });

  it("blocks pasting an SMS that is already a claim's receipt", async () => {
    // #given
    const text = buyGoodsSms({ code: randomCode() });
    const sms = await pasteSms(app, company, employee, text);
    const claimResponse = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [sms.receiptFileId],
          categoryId: utilitiesId,
          spentOn: "2026-10-15",
        }),
      },
    );
    expect(claimResponse.status).toBe(201);

    // #when
    const response = await send(
      "POST",
      `/organizations/${company.organizationId}/receipts/sms`,
      { text },
    );

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.duplicateOf.kind).toBe("claim");
  });

  it("warns about the same admin's claim for the same amount a day apart", async () => {
    // #given
    const receipt = await uploadReceipt(app, storage, company, company.admin);
    const claimResponse = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      company.admin,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [receipt.receiptFileId],
          categoryId: utilitiesId,
          amountKes: "4,500.00",
          spentOn: shiftDays(D, -1),
        }),
      },
    );
    const { data: claim } = (await claimResponse.json()) as {
      data: { id: string };
    };

    // #when
    const spending = await recordWithPhoto();

    // #then
    expect(spending.warnings).toEqual([
      {
        code: "near_duplicate",
        expenseId: claim.id,
        spentOn: shiftDays(D, -1),
        amountKes: "450000",
      },
    ]);
  });

  it("warns about spending dated more than 60 days ago", async () => {
    // #when
    const spending = await recordWithPhoto({ spentOn: shiftDays(TODAY, -61) });

    // #then
    expect(spending.warnings).toEqual([
      {
        code: "older_than_60_days",
        spentOn: shiftDays(TODAY, -61),
        ageDays: 61,
      },
    ]);
  });
});

describe("GET /organizations/:organizationId/company-spending", () => {
  it("lists the latest date first, with heading, account and amount", async () => {
    // #given
    const older = await recordWithPhoto({ spentOn: shiftDays(D, -3) });
    const newer = await recordWithPhoto({
      spentOn: D,
      paidFromAccountId: cardId,
      overviewHeading: "subscriptions",
    });

    // #when
    const listed = await listSpending();

    // #then
    expect(listed.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(listed[0]).toMatchObject({
      overviewHeading: "subscriptions",
      paidFromAccount: { id: cardId, name: "Founder's Visa card" },
      amountKes: "450000",
      noReceipt: false,
    });
  });

  it("filters by heading, category, account and dates", async () => {
    // #given
    const bank = await recordWithPhoto({ spentOn: shiftDays(D, -5) });
    const card = await recordWithPhoto({
      paidFromAccountId: cardId,
      categoryId: softwareId,
      overviewHeading: "subscriptions",
    });

    // #when
    const byHeading = await listSpending("?heading=subscriptions");
    const byCategory = await listSpending(`?categoryId=${utilitiesId}`);
    const byAccount = await listSpending(`?paidFromAccountId=${kcbId}`);
    const byDates = await listSpending(`?from=${shiftDays(D, -1)}&to=${D}`);

    // #then
    expect(byHeading.map((row) => row.id)).toEqual([card.id]);
    expect(byCategory.map((row) => row.id)).toEqual([bank.id]);
    expect(byAccount.map((row) => row.id)).toEqual([bank.id]);
    expect(byDates.map((row) => row.id)).toEqual([card.id]);
  });

  it("pages without skipping or repeating", async () => {
    // #given
    const recorded: string[] = [];
    for (const days of [0, -1, -1, -2]) {
      recorded.push(
        (await recordWithPhoto({ spentOn: shiftDays(D, days) })).id,
      );
    }

    // #when
    const first = await dataOf(
      await send("GET", `${base()}?limit=3`),
      companySpendingPageSchema,
    );
    const second = await dataOf(
      await send(
        "GET",
        `${base()}?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      ),
      companySpendingPageSchema,
    );

    // #then
    const seen = [...first.spending, ...second.spending].map((row) => row.id);
    expect(seen.sort()).toEqual([...recorded].sort());
    expect(second.nextCursor).toBeNull();
  });

  it("leaves claims out", async () => {
    // #given
    const receipt = await uploadReceipt(app, storage, company, employee);
    await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [receipt.receiptFileId],
          categoryId: utilitiesId,
        }),
      },
    );

    // #then
    expect(await listSpending()).toEqual([]);
  });

  it("answers 404 for a claim's ID", async () => {
    // #given
    const receipt = await uploadReceipt(app, storage, company, employee);
    const claimResponse = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [receipt.receiptFileId],
          categoryId: utilitiesId,
        }),
      },
    );
    const { data: claim } = (await claimResponse.json()) as {
      data: { id: string };
    };

    // #when
    const response = await send("GET", `${base()}/${claim.id}`);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("PATCH /organizations/:organizationId/company-spending/:spendingId", () => {
  it("changes the fields given, audited before and after", async () => {
    // #given
    const spending = await recordWithPhoto();

    // #when
    const response = await send("PATCH", `${base()}/${spending.id}`, {
      amountKes: "4,750.00",
      overviewHeading: "subscriptions",
      paidFromAccountId: cardId,
    });

    // #then
    expect(await dataOf(response, companySpendingDetailSchema)).toMatchObject({
      status: "recorded",
      amountKes: "475000",
      overviewHeading: "subscriptions",
      paidFromAccount: { id: cardId },
      merchant: "Kenya Power",
    });
    expect((await auditOf(spending.id)).at(-1)).toMatchObject({
      action: "expense.edited",
      actor_id: company.admin.id,
      before: {
        amountKes: "450000",
        overviewHeading: "transactions",
        paidFromAccountId: kcbId,
      },
      after: {
        amountKes: "475000",
        overviewHeading: "subscriptions",
        paidFromAccountId: cardId,
      },
    });
  });

  it("clears the no-receipt reason once a receipt is added", async () => {
    // #given
    const created = await dataOf(
      await recordWith({ noReceiptReason: "Receipt still with the driver" }),
      companySpendingDetailSchema,
    );
    const photo = await uploadReceipt(app, storage, company, company.admin);

    // #when
    const response = await send("PATCH", `${base()}/${created.id}`, {
      receiptFileIds: [photo.receiptFileId],
    });

    // #then
    expect(await dataOf(response, companySpendingDetailSchema)).toMatchObject({
      noReceipt: false,
      noReceiptReason: null,
      receiptCount: 1,
    });
  });

  it("refuses taking the last receipt off without a reason", async () => {
    // #given
    const spending = await recordWithPhoto();

    // #when
    const response = await send("PATCH", `${base()}/${spending.id}`, {
      receiptFileIds: [],
    });

    // #then
    expect(response.status).toBe(400);
    const unchanged = await dataOf(
      await send("GET", `${base()}/${spending.id}`),
      companySpendingDetailSchema,
    );
    expect(unchanged.receiptCount).toBe(1);
  });

  it("lets another admin edit it, keeping the first admin's receipt", async () => {
    // #given
    const spending = await recordWithPhoto();
    const secondAdmin = await createUser(db);
    await addMember(db, company, secondAdmin, { role: "admin" });
    const [receipt] = spending.receipts;

    // #when
    const response = await send(
      "PATCH",
      `${base()}/${spending.id}`,
      {
        receiptFileIds: [receipt?.id ?? ""],
        description: "October electricity, main office",
      },
      secondAdmin,
    );

    // #then
    expect(await dataOf(response, companySpendingDetailSchema)).toMatchObject({
      description: "October electricity, main office",
      receiptCount: 1,
    });
  });

  it("refuses another company's paid-from account", async () => {
    // #given
    const spending = await recordWithPhoto();
    const other = await createCompany(db);
    const theirs = await addAccount(other, "Their bank", "bank");

    // #when
    const response = await send("PATCH", `${base()}/${spending.id}`, {
      paidFromAccountId: theirs,
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("runs the duplicate rules again", async () => {
    // #given
    const code = randomCode();
    await importClaim({ amountKes: 10_000n, spentOn: D, mpesaCode: code });
    const spending = await recordWithPhoto();

    // #when
    const response = await send("PATCH", `${base()}/${spending.id}`, {
      mpesaCode: code,
    });

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.duplicateOf.kind).toBe("claim");
  });

  it("writes no audit entry when nothing changes", async () => {
    // #given
    const spending = await recordWithPhoto();

    // #when
    await send("PATCH", `${base()}/${spending.id}`, {
      merchant: "Kenya Power",
    });

    // #then
    expect(await auditOf(spending.id)).toHaveLength(1);
  });
});

describe("marking a bill paid outside Expendi records company spending", () => {
  let payeeId: string;

  beforeEach(async () => {
    payeeId = await insertPayee(db, company, {
      name: "Safaricom Fibre",
      kind: "vendor",
      method: "outside",
    });
  });

  async function billFor(values: { recurringItemId?: string } = {}) {
    return insertBill(db, company, {
      payeeId,
      categoryId: softwareId,
      overviewHeading: "subscriptions",
      amountKes: 1_299_900n,
      reference: "INV-0042",
      dueOn: shiftDays(TODAY, -2),
      status: "overdue",
      ...values,
    });
  }

  const markPaid = (billId: string, body: Record<string, unknown> = {}) =>
    sendJson(
      app,
      `/organizations/${company.organizationId}/bills/${billId}/mark-paid-outside`,
      company.admin,
      { method: "POST", body: { paidOn: shiftDays(TODAY, -1), ...body } },
    );

  it("records exactly one entry with the bill's amount, payee, heading, category, proof and link", async () => {
    // #given
    const billId = await billFor();
    const proof = await uploadReceipt(app, storage, company, company.admin);

    // #when
    const response = await markPaid(billId, {
      note: "Paid with the company card",
      receiptFileIds: [proof.receiptFileId],
      paidFromAccountId: cardId,
    });

    // #then
    expect(response.status).toBe(200);
    const [row, ...others] = await spendingOfBill(billId);
    expect(others).toEqual([]);
    const spending = await dataOf(
      await send("GET", `${base()}/${row?.id ?? ""}`),
      companySpendingDetailSchema,
    );
    expect(spending).toMatchObject({
      status: "recorded",
      merchant: "Safaricom Fibre",
      amountKes: "1299900",
      overviewHeading: "subscriptions",
      category: { id: softwareId },
      spentOn: shiftDays(TODAY, -1),
      description: "Bill INV-0042: Paid with the company card",
      paidFromAccount: { id: cardId },
      bill: {
        id: billId,
        payee: { id: payeeId, name: "Safaricom Fibre" },
        reference: "INV-0042",
      },
      noReceipt: false,
      receipts: [
        expect.objectContaining({ id: proof.receiptFileId, billRole: "proof" }),
      ],
    });
  });

  it("audits the entry alongside the bill", async () => {
    // #given
    const billId = await billFor();

    // #when
    await markPaid(billId, { paidFromAccountId: kcbId });

    // #then
    const [row] = await spendingOfBill(billId);
    expect(await auditOf(row?.id ?? "")).toEqual([
      expect.objectContaining({
        action: "expense.recorded",
        actor_id: company.admin.id,
        after: expect.objectContaining({
          billId,
          paidFromAccountId: kcbId,
        }) as unknown,
      }),
    ]);
  });

  it("still has one entry after the request is retried twice", async () => {
    // #given
    const billId = await billFor();
    await markPaid(billId);

    // #when
    const retries = [await markPaid(billId), await markPaid(billId)];

    // #then
    expect(retries.map((response) => response.status)).toEqual([409, 409]);
    expect(await spendingOfBill(billId)).toHaveLength(1);
  });

  it("records one entry however often the hook itself runs for the bill", async () => {
    // #given
    const billId = await billFor();
    const bill = await readBill(db, company, billId);
    const tenant: Tenant = {
      organizationId: company.organizationId,
      userId: company.admin.id,
      membershipId: company.adminMembershipId,
      role: "admin",
    };
    const record = () =>
      runtime.runPromise(
        withScope(tenant, (tx) =>
          recordBillSpending(tx, tenant, bill, {
            paidOn: TODAY,
            note: null,
            paidFromAccountId: null,
          }),
        ),
      );

    // #when
    const first = await record();
    const second = await record();

    // #then
    expect(second).toBe(first);
    expect(await spendingOfBill(billId)).toEqual([{ id: first }]);
  });

  it("refuses a second entry for the same bill in the database", async () => {
    // #given
    const billId = await billFor();
    await markPaid(billId);

    // #when
    const duplicate = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx.insert(expenses).values({
          organizationId: company.organizationId,
          membershipId: company.adminMembershipId,
          kind: "company",
          overviewHeading: "subscriptions",
          categoryId: softwareId,
          merchant: "Safaricom Fibre",
          amountKes: 1_299_900n,
          spentOn: TODAY,
          description: "Copy",
          status: "recorded",
          billId,
        }),
    );

    // #then
    await expect(duplicate).rejects.toThrow();
    expect(await spendingOfBill(billId)).toHaveLength(1);
  });

  it("leaves the account not specified and flags no receipt when neither is given", async () => {
    // #given
    const billId = await billFor();

    // #when
    await markPaid(billId);

    // #then
    const [row] = await spendingOfBill(billId);
    const spending = await dataOf(
      await send("GET", `${base()}/${row?.id ?? ""}`),
      companySpendingDetailSchema,
    );
    expect(spending).toMatchObject({
      paidFromAccount: null,
      noReceipt: true,
      noReceiptReason: null,
      description: "Bill INV-0042 paid outside Expendi",
    });
  });

  it("refuses another company's account and leaves the bill unpaid", async () => {
    // #given
    const billId = await billFor();
    const other = await createCompany(db);
    const theirs = await addAccount(other, "Their bank", "bank");

    // #when
    const response = await markPaid(billId, { paidFromAccountId: theirs });

    // #then
    expect(response.status).toBe(400);
    expect((await readBill(db, company, billId)).status).toBe("overdue");
    expect(await spendingOfBill(billId)).toEqual([]);
  });

  it("still creates a recurring payment's next bill", async () => {
    // #given
    const itemId = await insertRecurringItem(db, company, {
      payeeId,
      categoryId: softwareId,
      overviewHeading: "subscriptions",
      amountKes: 1_299_900n,
      schedule: "monthly",
      scheduleDay: 5,
      startsOn: shiftDays(TODAY, -40),
      nextDueOn: shiftDays(TODAY, 28),
    });
    const billId = await billFor({ recurringItemId: itemId });

    // #when
    const response = await markPaid(billId, { paidFromAccountId: cardId });

    // #then
    expect((await dataOf(response, billDetailSchema)).status).toBe(
      "paid_outside",
    );
    expect(await spendingOfBill(billId)).toHaveLength(1);
    expect(await billsOfItem(db, company, itemId)).toHaveLength(2);
  });

  it("lets the admin set the account later, but not the bill's amount", async () => {
    // #given
    const billId = await billFor();
    await markPaid(billId);
    const [row] = await spendingOfBill(billId);
    const path = `${base()}/${row?.id ?? ""}`;

    // #when
    const account = await send("PATCH", path, { paidFromAccountId: kcbId });
    const amount = await send("PATCH", path, { amountKes: "100.00" });

    // #then
    expect(
      (await dataOf(account, companySpendingDetailSchema)).paidFromAccount,
    ).toMatchObject({ id: kcbId });
    expect(amount.status).toBe(409);
  });
});

describe("admins only", () => {
  const routes = [
    ["GET", ""],
    ["POST", ""],
    ["GET", "/:id"],
    ["PATCH", "/:id"],
  ] as const;

  it.each(routes)("an employee gets 403 from %s %s", async (method, path) => {
    // #given
    const spending = await recordWithPhoto();
    const receipt = await uploadReceipt(app, storage, company, employee);

    // #when
    const response = await send(
      method,
      `${base()}${path.replace(":id", spending.id)}`,
      method === "GET"
        ? undefined
        : spendingRequest({
            receiptFileIds: [receipt.receiptFileId],
            amountKes: "1.00",
          }),
      employee,
    );

    // #then
    expect(response.status).toBe(403);
    const listed = await listSpending();
    expect(listed.map((row) => row.amountKes)).toEqual(["450000"]);
  });
});

describe("company isolation", () => {
  async function spendingIn(target: TestCompany): Promise<string> {
    const categoryId = await addCategory(db, target, `Rent ${randomUUID()}`);
    const [account] = await runInScope(
      db,
      { organizationId: target.organizationId },
      (tx) =>
        tx
          .insert(paidFromAccounts)
          .values({
            organizationId: target.organizationId,
            name: `Bank ${randomUUID()}`,
            kind: "bank",
          })
          .returning({ id: paidFromAccounts.id }),
    );
    const [row] = await runInScope(
      db,
      { organizationId: target.organizationId },
      (tx) =>
        tx
          .insert(expenses)
          .values({
            organizationId: target.organizationId,
            membershipId: target.adminMembershipId,
            kind: "company",
            overviewHeading: "transactions",
            categoryId,
            merchant: "Landlord",
            amountKes: 5_000_000n,
            spentOn: TODAY,
            description: "Rent",
            status: "recorded",
            paidFromAccountId: account?.id ?? null,
            noReceiptReason: "Paid by standing order",
          })
          .returning({ id: expenses.id }),
    );
    if (!row) throw new Error("spending insert returned no row");
    return row.id;
  }

  it("keeps each company's spending to itself in the database", async () => {
    // #given
    await spendingIn(fixture.companyA);
    await spendingIn(fixture.companyB);

    // #then
    await expectTableIsolation(fixture, "expenses");
  });

  it.each([
    ["GET", ""],
    ["POST", ""],
    ["GET", "/:id"],
    ["PATCH", "/:id"],
  ] as const)("%s %s refuses another company", async (method, path) => {
    // #given
    const spendingId = await spendingIn(fixture.companyA);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/company-spending${path.replace(":id", spendingId)}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      },
    }));
  });
});
