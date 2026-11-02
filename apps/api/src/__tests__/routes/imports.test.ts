import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
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
  bills,
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
import { createCompany } from "../helpers/db.js";
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

  it("skips old history, rejects future expenses, and deduplicates identical rows", async () => {
    const old = expenseInput();
    old.csv = old.csv.replace(today, "2020-01-01");
    expect((await preview(old)).skipped).toBe(1);
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
