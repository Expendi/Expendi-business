import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ImportRequest } from "@expendi-business/shared";
import {
  floatsResponseSchema,
  importHistoryDetailSchema,
  importHistoryPageSchema,
  importReportSchema,
  importResultSchema,
  parseImportCsv,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingConnections,
  accountingSyncs,
  bills,
  categories,
  expenses,
  importRows,
  importRuns,
  payees,
  payouts,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiToday } from "../../services/expenses/rules.js";
import { importAmount } from "../../services/import/parse.js";
import {
  addCategory,
  buyGoodsSms,
  claimRequest,
  pasteSms,
  sendJson,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime,
  db: Database,
  app: App,
  owner: pg.Pool,
  staff: TestStaff,
  company: TestCompany,
  categoryId: string;
const today = nairobiToday();
beforeAll(async () => {
  runtime = makeTestRuntime();
  db = (await runtime.runPromise(DatabaseService)).db;
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE });
  staff = await createStaff(owner);
});
afterAll(async () => {
  await runtime.dispose();
  await owner.end();
});
beforeEach(async () => {
  company = await createCompany(db);
  categoryId = await addCategory(db, company, "Office");
});

function request(
  kind: ImportRequest["kind"],
  values: Record<string, string>,
): ImportRequest {
  const keys = Object.keys(values);
  const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
  return {
    kind,
    fileName: "pilot.csv",
    csv:
      keys.join(",") + "\n" + keys.map((k) => quote(values[k] ?? "")).join(","),
    mapping: Object.fromEntries(keys.map((k) => [k, k])),
  };
}
const expenseInput = (kind: "history" | "claim" = "history", code = "") =>
  request(kind, {
    name: "Office shop",
    email: company.admin.email,
    category: "Office",
    amount: "1,500.50",
    date: today,
    mpesaCode: code,
  });
async function call(
  input: ImportRequest,
  token?: string,
  org = company.organizationId,
  actor = staff,
) {
  return sendJson(
    app,
    `/internal/companies/${org}/imports/${token ? "commit" : "preview"}`,
    actor,
    {
      method: "POST",
      body: { ...input, ...(token ? { previewToken: token } : {}) },
    },
  );
}
async function preview(input: ImportRequest) {
  const res = await call(input);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { data: unknown };
  return importReportSchema.parse(body.data);
}
async function commit(input: ImportRequest) {
  const report = await preview(input);
  expect(report.errors, JSON.stringify(report)).toBe(0);
  if (!report.previewToken) throw new Error("missing preview token");
  const res = await call(input, report.previewToken);
  expect(res.status, await res.clone().text()).toBe(200);
  return importResultSchema.parse(
    ((await res.json()) as { data: unknown }).data,
  );
}
async function readState() {
  const audit = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE organization_id=$1 ORDER BY occurred_at, id",
    [company.organizationId],
  );
  return runInScope(
    db,
    { organizationId: company.organizationId, role: "admin" },
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.import_staff_id', ${staff.staffUserId}, true)`,
      );
      return {
        runs: await tx.select().from(importRuns),
        rows: await tx.select().from(importRows),
        expenses: await tx.select().from(expenses),
        payouts: await tx.select().from(payouts),
        payees: await tx.select().from(payees),
        categories: await tx.select().from(categories),
        recurring: await tx.select().from(recurringItems),
        bills: await tx.select().from(bills),
        audit: audit.rows,
      };
    },
  );
}

describe("spreadsheet import", () => {
  it("previews Shanga TSV with source rows, skips headings and deduplicates repeated imports", async () => {
    const header =
      "Expense Category\tItem Description\tPurchased By\tDate Purchased\tCost\tVendor\tStatus\tMember Email";
    const input: ImportRequest = {
      kind: "history",
      layout: "shanga",
      fileName: "sanitized-shanga.tsv",
      csv: `${header}\n\n${header}\nOffice\tPaper\tTest Admin\t${today}\t1,500.50\tTest Shop\tpaid\t${company.admin.email}`,
      mapping: {
        category: "Expense Category",
        description: "Item Description",
        date: "Date Purchased",
        amount: "Cost",
        name: "Vendor",
        email: "Member Email",
      },
    };
    const report = await preview(input);
    expect(report.rows.map((r) => [r.row, r.status])).toEqual([
      [3, "skipped"],
      [4, "ready"],
    ]);
    expect((await readState()).expenses).toHaveLength(0);
    expect((await commit(input)).imported).toBe(1);
    expect((await preview(input)).ready).toBe(0);
    const state = await readState();
    expect(state.expenses).toHaveLength(1);
    expect(state.expenses[0]?.amountKes).toBe(150050n);
    expect(state.payouts).toHaveLength(0);
    const mixed = await preview({
      ...input,
      csv: input.csv.replace("\tpaid\t", "\tunpaid\t"),
    });
    expect(mixed.errors).toBe(1);
    expect(mixed.previewToken).toBeNull();
  });
  it("imports all 25 public UKEF payments through mapped columns with explicit test-only GBP conversion", async () => {
    const bytes = readFileSync(
      new URL("../fixtures/imports/ukef-july-2026.csv", import.meta.url),
    );
    const original = new TextDecoder("windows-1252").decode(bytes);
    const parsed = parseImportCsv(original);
    expect(parsed.rows).toHaveLength(25);
    const index = (header: string) => parsed.headers.indexOf(header);
    const amountAt = index("Amount in Sterling");
    expect(() => importAmount(parsed.rows[0]?.[amountAt] ?? "")).toThrow();
    let expectedKesCents = 0n;
    const csvRows = parsed.rows.map((row) => {
      // £1 = KES 100 solely in this fixture; preserve original GBP column.
      const gbpPence = importAmount((row[amountAt] ?? "").replace("£", ""));
      expectedKesCents += gbpPence * 100n;
      return [...row, gbpPence.toString(), company.admin.email, "Office"];
    });
    const encodeRow = (row: string[]) =>
      row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",");
    const input: ImportRequest = {
      kind: "history",
      fileName: "ukef-test-adaptation.csv",
      csv: [
        [
          ...parsed.headers,
          "KES test amount",
          "Fixture member",
          "Fixture category",
        ],
        ...csvRows,
      ]
        .map(encodeRow)
        .join("\r\n"),
      mapping: {
        name: "Supplier name",
        date: "Date of Payment",
        amount: "KES test amount",
        description: "Expense Description",
        email: "Fixture member",
        category: "Fixture category",
      },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
    try {
      expect((await commit(input)).imported).toBe(25);
      const state = await readState();
      expect(state.expenses.reduce((sum, e) => sum + e.amountKes, 0n)).toBe(
        expectedKesCents,
      );
      expect(
        state.expenses.every(
          (e) =>
            e.spentOn.startsWith("2026-07-") && e.status === "paid_outside",
        ),
      ).toBe(true);
      expect((await commit(input)).imported).toBe(0);
      expect((await readState()).payouts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("previews without any database writes; commits audited history and reruns safely", async () => {
    const input = expenseInput();
    const before = await readState();
    const report = await preview(input);
    expect(report.ready).toBe(1);
    expect(await readState()).toEqual(before);
    expect((await commit(input)).imported).toBe(1);
    const state = await readState();
    expect(state.expenses[0]).toMatchObject({
      status: "paid_outside",
      source: "import",
      etimsStatus: "none",
      amountKes: 150050n,
    });
    expect(state.payouts).toHaveLength(0);
    expect(state.audit.some((a) => a.action === "import.completed")).toBe(true);
    expect((await commit({ ...input, fileName: "renamed.csv" })).imported).toBe(
      0,
    );
    expect((await readState()).expenses).toHaveLength(1);
  });

  it("requires an authentic preview bound to the staff, company and contents", async () => {
    const input = expenseInput();
    const report = await preview(input);
    const token = report.previewToken ?? "invalid";
    expect((await call(input, "forged")).status).toBe(409);
    expect(
      (
        await call(
          { ...input, csv: input.csv.replace("1,500.50", "2,000.00") },
          token,
        )
      ).status,
    ).toBe(409);
    const other = await createStaff(owner);
    expect(
      (await call(input, token, company.organizationId, other)).status,
    ).toBe(409);
    const otherCompany = await createCompany(db);
    await addCategory(db, otherCompany, "Office");
    expect((await call(input, token, otherCompany.organizationId)).status).toBe(
      409,
    );
    expect((await readState()).expenses).toHaveLength(0);
  });

  it("serializes concurrent commits without duplicate records or payouts", async () => {
    const input = expenseInput();
    const token = (await preview(input)).previewToken ?? "invalid";
    const responses = await Promise.all([
      call(input, token),
      call(input, token),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await readState()).expenses).toHaveLength(1);
    expect((await readState()).payouts).toHaveLength(0);
  });

  it("reports all invalid rows and imports nothing", async () => {
    const input = expenseInput();
    input.csv +=
      '\n"Shop","missing@example.com","Office","9.999","31/02/2026",""';
    const report = await preview(input);
    expect(report.ready).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.previewToken).toBeNull();
    expect((await readState()).rows).toHaveLength(0);
  });

  it("imports payees without payment details, salaries, recurring items and bills", async () => {
    await commit(
      request("payee", {
        name: "Employee",
        payeeKind: "employee",
        email: company.admin.email,
      }),
    );
    await commit(request("payee", { name: "Supplier" }));
    await commit(
      request("salary", {
        payee: "Employee",
        category: "Office",
        amount: "30000",
        date: "2027-01-31",
        scheduleDay: "31",
      }),
    );
    await commit(
      request("recurring", {
        payee: "Supplier",
        category: "Office",
        heading: "subscriptions",
        amount: "2500",
        date: "2027-01-31",
        scheduleDay: "31",
        payVia: "outside",
      }),
    );
    await commit(
      request("bill", {
        payee: "Supplier",
        category: "Office",
        amount: "999.99",
        date: "2027-01-15",
      }),
    );
    const state = await readState();
    expect(
      state.payees.every(
        (p) => p.method === null && p.detailsChangedAt === null,
      ),
    ).toBe(true);
    expect(state.recurring.map((r) => r.overviewHeading).sort()).toEqual([
      "salaries",
      "subscriptions",
    ]);
    expect(state.bills[0]).toMatchObject({
      amountKes: 99999n,
      status: "upcoming",
    });
    expect(state.payouts).toHaveLength(0);
    const report = await preview(
      request("salary", {
        payee: "Employee",
        category: "Office",
        amount: "31000",
        date: "2027-01-31",
      }),
    );
    expect(report.errors).toBe(1);
  });

  it("imports an open float with correct issued, spent and remaining totals and no payout", async () => {
    await commit(
      request("float", {
        email: company.admin.email,
        issued: "1000",
        left: "250.50",
        date: today,
      }),
    );
    const res = await sendJson(
      app,
      `/organizations/${company.organizationId}/floats`,
      company.admin,
    );
    expect(res.status).toBe(200);
    const data = floatsResponseSchema.parse(
      ((await res.json()) as { data: unknown }).data,
    );
    expect(data.floats[0]).toMatchObject({
      issuedKes: "100000",
      spentKes: "74950",
      leftKes: "25050",
    });
    expect((await readState()).payouts).toHaveLength(0);
    expect(
      (
        await preview(
          request("float", {
            email: company.admin.email,
            issued: "100",
            left: "101",
            date: today,
          }),
        )
      ).errors,
    ).toBe(1);
  });

  it("imports submitted claims and includes history in normal M-Pesa duplicate checks", async () => {
    await commit(expenseInput("claim"));
    expect((await readState()).expenses[0]?.status).toBe("submitted");
    const code = `S${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
    await commit(expenseInput("history", code));
    const receipt = await pasteSms(
      app,
      company,
      company.admin,
      buyGoodsSms({ code }),
    );
    const res = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      company.admin,
      {
        method: "POST",
        body: claimRequest({
          categoryId,
          receiptFileIds: [receipt.receiptFileId],
          mpesaCode: code,
        }),
      },
    );
    expect(res.status, await res.clone().text()).toBe(409);
  });

  it("supports older financial periods, rejects future expenses, and deduplicates identical rows", async () => {
    const old = expenseInput();
    old.csv = old.csv.replace(today, "2020-01-01");
    expect((await preview(old)).ready).toBe(1);
    const future = expenseInput();
    future.csv = future.csv.replace(today, "2099-01-01");
    expect((await preview(future)).errors).toBe(1);
    const duplicate = expenseInput();
    duplicate.csv += "\n" + duplicate.csv.split("\n")[1];
    const result = await commit(duplicate);
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("rejects nonstaff/viewers and keeps company references and import records isolated", async () => {
    const input = expenseInput();
    const viewer = await createStaff(owner, { role: "ops_viewer" });
    expect(
      (await call(input, undefined, company.organizationId, viewer)).status,
    ).toBe(403);
    const res = await sendJson(
      app,
      `/internal/companies/${company.organizationId}/imports/preview`,
      company.admin,
      { method: "POST", body: input },
    );
    expect(res.status).toBe(403);
    await commit(input);
    const other = await createCompany(db);
    await addCategory(db, other, "Office");
    const response = await call(input, undefined, other.organizationId);
    const report = importReportSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(report.errors).toBe(1);
    const hidden = await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) => tx.select().from(importRuns),
    );
    expect(hidden).toEqual([]);
    const elsewhere = await runInScope(
      db,
      { organizationId: other.organizationId, role: "admin" },
      async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.import_staff_id', ${staff.staffUserId}, true)`,
        );
        return tx.select().from(importRows);
      },
    );
    expect(elsewhere).toEqual([]);
  });
});

describe("company-admin imports", () => {
  const newBill = () => ({
    ...request("bill", {
      payee: "New Supplier",
      category: "New Category",
      amount: "1500.50",
      date: today,
      status: "unpaid",
      reference: "AUTO-1",
    }),
    createMissing: true,
  });
  const input = () =>
    request("history", {
      name: "Company supplier",
      category: "Office",
      amount: "1250.50",
      date: "2026-06-15",
      status: "paid",
    });
  const customerCall = (
    body: ImportRequest,
    token?: string,
    actor = company.admin,
    org = company.organizationId,
  ) =>
    sendJson(
      app,
      `/organizations/${org}/imports/${token ? "commit" : "preview"}`,
      actor,
      {
        method: "POST",
        body: { ...body, ...(token ? { previewToken: token } : {}) },
      },
    );
  async function customerPreview(body: ImportRequest, actor = company.admin) {
    const res = await customerCall(body, undefined, actor);
    expect(res.status, await res.clone().text()).toBe(200);
    return importReportSchema.parse(
      ((await res.json()) as { data: unknown }).data,
    );
  }
  async function customerCommit(body: ImportRequest, actor = company.admin) {
    const report = await customerPreview(body, actor);
    expect(report.errors).toBe(0);
    const res = await customerCall(
      body,
      report.previewToken ?? "invalid",
      actor,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    return importResultSchema.parse(
      ((await res.json()) as { data: unknown }).data,
    );
  }
  it("previews unique new suppliers/categories without writes and atomically creates them once across retries", async () => {
    const body = newBill();
    body.csv += `\n" new supplier "," new category ","200","${today}","unpaid","AUTO-2"`;
    const before = await readState();
    const report = await customerPreview(body);
    expect(report.errors).toBe(0);
    expect(report.ready).toBe(2);
    expect(report.totalKes).toBe("170050");
    expect(report.newRecords).toEqual([
      { kind: "category", name: "New Category" },
      { kind: "supplier", name: "New Supplier" },
    ]);
    expect(report.rows.every((r) => r.newRecords?.length === 2)).toBe(true);
    expect(await readState()).toEqual(before);
    const token = report.previewToken ?? "invalid";
    const results = await Promise.all([
      customerCall(body, token),
      customerCall(body, token),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const state = await readState();
    expect(state.payees).toHaveLength(1);
    expect(state.payees[0]).toMatchObject({
      name: "New Supplier",
      kind: "supplier",
      method: null,
      membershipId: null,
      detailsChangedAt: null,
    });
    expect(
      state.categories.filter((c) => c.name === "New Category"),
    ).toHaveLength(1);
    expect(state.bills).toHaveLength(2);
    expect(new Set(state.bills.map((b) => b.payeeId)).size).toBe(1);
    expect(state.payouts).toHaveLength(0);
    expect((await customerPreview(body)).newRecords).toEqual([]);
    expect((await customerCommit(body)).imported).toBe(0);
    const entries = await owner.query(
      "SELECT actor_type, actor_id, action, after FROM audit_log WHERE organization_id=$1 AND action IN ('payee.created','category.created')",
      [company.organizationId],
    );
    expect(entries.rows).toHaveLength(2);
    for (const entry of entries.rows)
      expect(entry).toMatchObject({
        actor_type: "user",
        actor_id: company.admin.id,
        after: { source: "import" },
      });
  });
  it("creates only a category for paid expenses and preserves old-client opt-in boundaries", async () => {
    const body = {
      ...request("history", {
        name: "Unknown Merchant",
        category: "Imported Travel",
        amount: "50",
        date: "2026-06-15",
      }),
      createMissing: true,
    };
    expect(
      (await customerPreview({ ...body, createMissing: false } as typeof body))
        .errors,
    ).toBe(1);
    const report = await customerPreview(body);
    expect(report.newRecords).toEqual([
      { kind: "category", name: "Imported Travel" },
    ]);
    expect(
      (
        await customerCall(
          { ...body, createMissing: false } as typeof body,
          report.previewToken ?? "invalid",
        )
      ).status,
    ).toBe(409);
    expect((await customerCommit(body)).imported).toBe(1);
    expect((await readState()).payees).toHaveLength(0);
    const staffInput = { ...expenseInput(), createMissing: true };
    staffInput.csv = staffInput.csv.replace('"Office"', '"Staff Missing"');
    expect((await preview(staffInput)).errors).toBe(1);
  });
  it("matches existing names and blocks archived, ambiguous and overlong new names", async () => {
    await commit(request("payee", { name: "Supplier" }));
    const body = {
      ...request("bill", {
        payee: " SUPPLIER ",
        category: " office ",
        amount: "100",
        date: today,
      }),
      createMissing: true,
    };
    expect((await customerPreview(body)).newRecords).toEqual([]);
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx.insert(payees).values({
          organizationId: company.organizationId,
          kind: "vendor",
          name: "supplier",
        }),
    );
    expect((await customerPreview(body)).rows[0]?.message).toContain(
      "More than one active supplier",
    );
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) => tx.update(payees).set({ archived: true }),
    );
    expect((await customerPreview(body)).rows[0]?.message).toContain(
      "archived supplier",
    );
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) => tx.update(categories).set({ archived: true }),
    );
    expect((await customerPreview(body)).rows[0]?.message).toContain(
      "archived category",
    );
    const longCategory = newBill();
    longCategory.csv = longCategory.csv.replace("New Category", "a".repeat(61));
    expect((await customerPreview(longCategory)).rows[0]?.message).toContain(
      "60 characters",
    );
    const longSupplier = newBill();
    longSupplier.csv = longSupplier.csv.replace(
      "New Supplier",
      "a".repeat(121),
    );
    expect((await customerPreview(longSupplier)).rows[0]?.message).toContain(
      "120 characters",
    );
  });
  it("requires a fresh preview when a missing name is created elsewhere and remains tenant isolated", async () => {
    const body = newBill();
    const report = await customerPreview(body);
    const other = await createCompany(db);
    await addCategory(db, other, "New Category");
    await runInScope(
      db,
      { organizationId: other.organizationId, role: "admin" },
      (tx) =>
        tx.insert(payees).values({
          organizationId: other.organizationId,
          kind: "supplier",
          name: "New Supplier",
        }),
    );
    expect((await customerPreview(body)).newRecords).toEqual(report.newRecords);
    await addCategory(db, company, "New Category");
    expect(
      (await customerCall(body, report.previewToken ?? "invalid")).status,
    ).toBe(409);
    expect((await readState()).payees).toHaveLength(0);
    expect((await customerCommit(body)).imported).toBe(1);
    const state = await readState();
    expect(
      state.payees.every((p) => p.organizationId === company.organizationId),
    ).toBe(true);
    const createdPayee = state.payees[0];
    if (!createdPayee) throw new Error("Expected new supplier");
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx
          .update(payees)
          .set({ name: "Renamed Supplier" })
          .where(eq(payees.id, createdPayee.id)),
    );
    expect((await customerPreview(body)).rows[0]?.message).toContain(
      "was renamed",
    );
  });
  it("does not create references for invalid rows and rejects confirmation of an error preview", async () => {
    const body = newBill();
    body.csv += `\n"Invalid Supplier","Invalid Category","not-money","${today}","unpaid","BAD"`;
    const before = await readState();
    const report = await customerPreview(body);
    expect(report.errors).toBe(1);
    expect(report.previewToken).toBeNull();
    expect(report.newRecords?.some((r) => r.name.startsWith("Invalid"))).toBe(
      false,
    );
    expect((await customerCall(body, "forged")).status).toBe(409);
    expect(await readState()).toEqual(before);
  });
  it("rolls back new references, bills and audits if the transaction fails after reference creation", async () => {
    const body = newBill();
    const report = await customerPreview(body);
    const before = await readState();
    await owner.query(`CREATE FUNCTION test_import_reference_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id = '${company.organizationId}'::uuid AND NEW.action = 'bill.imported' THEN
        RAISE EXCEPTION 'Test import rollback';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_import_reference_rollback BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_import_reference_rollback();`);
    try {
      expect(
        (await customerCall(body, report.previewToken ?? "invalid")).status,
      ).toBe(500);
      expect(await readState()).toEqual(before);
    } finally {
      await owner.query(
        "DROP TRIGGER test_import_reference_rollback ON audit_log; DROP FUNCTION test_import_reference_rollback();",
      );
    }
    expect(
      (await customerCall(body, report.previewToken ?? "invalid")).status,
    ).toBe(200);
  });
  it("imports older paid expenses as company spending with member provenance, exact total and no payout", async () => {
    // Even pending Zoho connections would queue newly recorded spending.
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx
          .insert(accountingConnections)
          .values({ organizationId: company.organizationId }),
    );
    const body = input();
    const before = await readState();
    const report = await customerPreview(body);
    expect(report.totalKes).toBe("125050");
    expect(await readState()).toEqual(before);
    const result = await customerCommit(body);
    const state = await readState();
    expect(state.expenses[0]).toMatchObject({
      kind: "company",
      status: "recorded",
      source: "import",
      spentOn: "2026-06-15",
      membershipId: company.adminMembershipId,
      amountKes: 125050n,
    });
    expect(state.payouts).toHaveLength(0);
    expect(state.runs[0]).toMatchObject({
      staffUserId: null,
      membershipId: company.adminMembershipId,
    });
    const syncs = await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) => tx.select().from(accountingSyncs),
    );
    expect(syncs).toHaveLength(0);
    const audit = await owner.query(
      "SELECT actor_type, actor_id FROM audit_log WHERE entity_id=$1 AND action='import.completed'",
      [result.runId],
    );
    expect(audit.rows).toEqual([
      { actor_type: "user", actor_id: company.admin.id },
    ]);
    const list = await sendJson(
      app,
      `/organizations/${company.organizationId}/imports`,
      company.admin,
    );
    expect(list.status).toBe(200);
    const history = importHistoryPageSchema.parse(
      ((await list.json()) as { data: unknown }).data,
    );
    expect(history.imports[0]).toMatchObject({
      id: result.runId,
      importedBy: company.admin.email,
      rowsImported: 1,
    });
    const detail = await sendJson(
      app,
      `/organizations/${company.organizationId}/imports/${result.runId}`,
      company.admin,
    );
    expect(
      importHistoryDetailSchema.parse(
        ((await detail.json()) as { data: unknown }).data,
      ).rows[0]?.status,
    ).toBe("ready");
    const expensesList = await sendJson(
      app,
      `/organizations/${company.organizationId}/expenses?month=2026-06`,
      company.admin,
    );
    expect(expensesList.status).toBe(200);
    expect(await expensesList.text()).toContain("Company supplier");
  });
  it("keeps preview tokens actor/company/content bound and deduplicates across admins and concurrent retries", async () => {
    const body = input();
    const report = await customerPreview(body);
    const token = report.previewToken ?? "invalid";
    const other = await createUser(db);
    await addMember(db, company, other, { role: "admin" });
    expect((await customerCall(body, token, other)).status).toBe(409);
    expect(
      (await customerCall({ ...body, fileName: "changed.csv" }, token)).status,
    ).toBe(409);
    expect(
      (
        await customerCall(
          { ...body, csv: body.csv.replace("1250.50", "2000") },
          token,
        )
      ).status,
    ).toBe(409);
    const results = await Promise.all([
      customerCall(body, token),
      customerCall(body, token),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (await customerCommit({ ...body, fileName: "renamed.csv" }, other))
        .imported,
    ).toBe(0);
    expect((await readState()).expenses).toHaveLength(1);
  });
  it("imports unpaid bills without paying, and blocks invalid or paid bill rows atomically", async () => {
    await commit(request("payee", { name: "Supplier" }));
    const bill = request("bill", {
      payee: "Supplier",
      category: "Office",
      amount: "3000",
      date: "2026-06-15",
      status: "unpaid",
      reference: "INV-TEST-001",
    });
    expect((await customerCommit(bill)).imported).toBe(1);
    const state = await readState();
    expect(state.bills[0]).toMatchObject({
      amountKes: 300000n,
      status: "overdue",
      reference: "INV-TEST-001",
    });
    expect(state.expenses).toHaveLength(0);
    expect(state.payouts).toHaveLength(0);
    const bad = { ...bill, csv: bill.csv.replace('"unpaid"', '"paid"') };
    expect((await customerPreview(bad)).errors).toBe(1);
    expect((await customerCall(bad, "forged")).status).toBe(409);
    const mixed = input();
    mixed.csv += '\n"Unknown","Missing category","50","2026-06-15","paid"';
    const report = await customerPreview(mixed);
    expect(report.ready).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.previewToken).toBeNull();
    expect((await customerCall(mixed, "forged")).status).toBe(409);
    expect((await readState()).expenses).toHaveLength(0);
  });
  it("rejects other roles, unsupported kinds, removed members, cross-company reads and writes", async () => {
    const body = input();
    const result = await customerCommit(body);
    const savedRun = (await readState()).runs[0];
    if (!savedRun) throw new Error("Expected import provenance");
    await expect(
      runInScope(
        db,
        {
          organizationId: company.organizationId,
          userId: company.admin.id,
          role: "admin",
        },
        (tx) =>
          tx.insert(importRuns).values({
            ...savedRun,
            id: randomUUID(),
            staffUserId: staff.staffUserId,
            membershipId: null,
          }),
      ),
    ).rejects.toThrow();
    for (const role of ["employee", "accountant"] as const) {
      const user = await createUser(db);
      await addMember(db, company, user, { role });
      expect((await customerCall(body, undefined, user)).status).toBe(403);
      expect((await customerCall(body, "forged", user)).status).toBe(403);
      expect(
        (
          await sendJson(
            app,
            `/organizations/${company.organizationId}/imports`,
            user,
          )
        ).status,
      ).toBe(403);
      const direct = await runInScope(
        db,
        { organizationId: company.organizationId, userId: user.id, role },
        (tx) => tx.select().from(importRuns),
      );
      expect(direct).toEqual([]);
    }
    const removed = await createUser(db);
    await addMember(db, company, removed, { role: "admin", status: "removed" });
    expect((await customerCall(body, undefined, removed)).status).toBe(403);
    for (const kind of [
      "payee",
      "salary",
      "recurring",
      "claim",
      "float",
    ] as const)
      expect((await customerCall({ ...body, kind })).status).toBe(400);
    const other = await createCompany(db);
    expect(
      (await customerCall(body, undefined, company.admin, other.organizationId))
        .status,
    ).toBe(403);
    expect(
      (
        await sendJson(
          app,
          `/organizations/${other.organizationId}/imports/${result.runId}`,
          other.admin,
        )
      ).status,
    ).toBe(404);
    const list = await sendJson(
      app,
      `/organizations/${other.organizationId}/imports`,
      other.admin,
    );
    expect(
      importHistoryPageSchema.parse(
        ((await list.json()) as { data: unknown }).data,
      ).imports,
    ).toEqual([]);
    const scoped = await runInScope(
      db,
      {
        organizationId: other.organizationId,
        userId: other.admin.id,
        role: "admin",
      },
      (tx) => tx.select().from(importRows),
    );
    expect(scoped).toEqual([]);
  });
  it("reports currency mismatches and preserves company separation in history pagination", async () => {
    await commit(request("payee", { name: "USDC vendor" }));
    await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx
          .update(payees)
          .set({
            method: "usdc",
            usdcChain: "base",
            usdcAddress: "0x1111111111111111111111111111111111111111",
            detailsChangedAt: new Date(),
          })
          .where(eq(payees.name, "USDC vendor")),
    );
    const report = await customerPreview(
      request("bill", {
        payee: "USDC vendor",
        category: "Office",
        amount: "100",
        date: today,
      }),
    );
    expect(report.errors).toBe(1);
    expect(report.rows[0]?.message).toContain("USDC");
    expect((await readState()).bills).toHaveLength(0);
    const result = await customerCommit(input());
    const savedRun = (await readState()).runs.find(
      (r) => r.id === result.runId,
    );
    if (!savedRun) throw new Error("Expected completed import");
    await runInScope(
      db,
      {
        organizationId: company.organizationId,
        userId: company.admin.id,
        role: "admin",
      },
      (tx) =>
        tx.insert(importRuns).values(
          Array.from({ length: 20 }, () => ({
            ...savedRun,
            id: randomUUID(),
          })),
        ),
    );
    const first = await sendJson(
      app,
      `/organizations/${company.organizationId}/imports`,
      company.admin,
    );
    const page = importHistoryPageSchema.parse(
      ((await first.json()) as { data: unknown }).data,
    );
    expect(page.imports).toHaveLength(20);
    expect(page.nextOffset).toBe(20);
    const second = await sendJson(
      app,
      `/organizations/${company.organizationId}/imports?offset=20`,
      company.admin,
    );
    const next = importHistoryPageSchema.parse(
      ((await second.json()) as { data: unknown }).data,
    );
    expect(next.imports).toHaveLength(2); // One staff payee import plus 21 customer imports.
    expect(next.nextOffset).toBeNull();
    expect(
      new Set([...page.imports, ...next.imports].map((r) => r.id)).size,
    ).toBe(22);
    expect(
      [...page.imports, ...next.imports].some((r) => r.id === result.runId),
    ).toBe(true);
  });
});
