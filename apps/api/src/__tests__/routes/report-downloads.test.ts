import { strFromU8 } from "fflate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ReportFormat } from "@expendi-business/shared";
import { expensesPageSchema, reportFilename } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { exportSeeder, nameUser, parseCsv, unzip } from "../helpers/exports.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const FORMATS: readonly ReportFormat[] = [
  "workbook",
  "csv",
  "receipts",
  "etims",
];

/** A company with its admin, an accountant and an employee. */
async function company() {
  const target = await createCompany(db);
  await nameUser(db, target.admin, "Jane Wanjiku");
  const wallet = await createActiveWallet(db, target);
  const accountant = await createUser(db);
  await addMember(db, target, accountant, { role: "accountant" });
  const employee = await createUser(db);
  await nameUser(db, employee, "Peter Otieno");
  const employeeMembershipId = await addMember(db, target, employee);
  return {
    company: target,
    accountant,
    employee,
    employeeMembershipId,
    officeId: await addCategory(db, target, "Office"),
    seed: exportSeeder(db, target, wallet.id, storage),
  };
}

function download(
  target: TestCompany,
  user: Pick<TestUser, "privyUserId">,
  month: string,
  format: string,
): Promise<Response> {
  return sendJson(
    app,
    `/organizations/${target.organizationId}/reports/${month}/${format}`,
    user,
  );
}

const bytesOf = async (response: Response): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());

async function file(
  target: TestCompany,
  user: Pick<TestUser, "privyUserId">,
  format: ReportFormat,
) {
  const response = await download(target, user, "2026-10", format);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    name: response.headers.get("content-disposition"),
    bytes: await bytesOf(response),
  };
}

describe("downloading a month as an accountant", () => {
  it("downloads the Excel workbook, the CSV files and the receipts zip as files", async () => {
    // #given
    const { company: target, accountant, officeId, seed } = await company();
    const lunch = await seed.expense({
      kind: "company",
      categoryId: officeId,
      merchant: "Java House",
      amountKes: 150_000n,
      spentOn: "2026-10-15",
    });
    await seed.receipt({ expenseId: lunch.id });

    // #when
    const workbook = await file(target, accountant, "workbook");
    const csv = await file(target, accountant, "csv");
    const receipts = await file(target, accountant, "receipts");

    // #then
    const sheet = unzip(workbook.bytes)["xl/worksheets/sheet1.xml"];
    const [header = [], row = []] = parseCsv(
      unzip(csv.bytes)["money-out.csv"] ?? new Uint8Array(),
    );
    expect({
      files: [workbook, csv, receipts].map(({ status, type, name }) => [
        status,
        type,
        name,
      ]),
      sheet: strFromU8(sheet ?? new Uint8Array()).includes("Java House"),
      receiptFiles: Object.keys(unzip(receipts.bytes)),
    }).toEqual({
      files: [
        [
          200,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          'attachment; filename="expendi-2026-10.xlsx"',
        ],
        [
          200,
          "application/zip",
          'attachment; filename="expendi-2026-10-csv.zip"',
        ],
        [
          200,
          "application/zip",
          'attachment; filename="expendi-2026-10-receipts.zip"',
        ],
      ],
      sheet: true,
      receiptFiles: [row[header.indexOf("Receipt file")]],
    });
  });

  it("downloads the eTIMS report as a UTF-8 CSV with a byte-order mark", async () => {
    // #given
    const { company: target, accountant, officeId, seed } = await company();
    await seed.expense({ categoryId: officeId, spentOn: "2026-10-15" });

    // #when
    const response = await download(target, accountant, "2026-10", "etims");

    // #then
    const bytes = await bytesOf(response);
    expect({
      status: response.status,
      type: response.headers.get("content-type"),
      name: response.headers.get("content-disposition"),
      bom: [...bytes.slice(0, 3)],
      header: parseCsv(bytes)[0],
    }).toEqual({
      status: 200,
      type: "text/csv; charset=utf-8",
      name: 'attachment; filename="expendi-2026-10-etims.csv"',
      bom: [0xef, 0xbb, 0xbf],
      header: [
        "Date",
        "Merchant",
        "Amount (KES)",
        "eTIMS status",
        "Invoice number",
        "Supplier PIN",
      ],
    });
  });

  it("names each file the way the dashboard saves it", async () => {
    // #given
    const { company: target, accountant } = await company();

    // #when
    const names = await Promise.all(
      FORMATS.map(async (format) =>
        (await download(target, accountant, "2026-10", format)).headers.get(
          "content-disposition",
        ),
      ),
    );

    // #then
    expect(names).toEqual(
      FORMATS.map(
        (format) =>
          `attachment; filename="${reportFilename("2026-10", format)}"`,
      ),
    );
  });

  it("keeps every download out of caches", async () => {
    // #given
    const { company: target, accountant } = await company();

    // #when
    const headers = await Promise.all(
      FORMATS.map(async (format) => {
        const response = await download(target, accountant, "2026-10", format);
        return [
          response.headers.get("cache-control"),
          response.headers.get("x-content-type-options"),
        ];
      }),
    );

    // #then
    expect(headers).toEqual(
      FORMATS.map(() => ["private, no-store", "nosniff"]),
    );
  });

  it("writes nothing: no stored export, link, audit entry or file", async () => {
    // #given
    const { company: target, accountant, officeId, seed } = await company();
    const lunch = await seed.expense({ categoryId: officeId });
    await seed.receipt({ expenseId: lunch.id });
    const counts = async () => {
      const { rows } = await owner.query<{
        exports: string;
        links: string;
        audits: string;
      }>(
        `SELECT
          (SELECT count(*) FROM report_exports WHERE organization_id = $1) AS exports,
          (SELECT count(*) FROM report_export_links WHERE organization_id = $1) AS links,
          (SELECT count(*) FROM audit_log WHERE organization_id = $1) AS audits`,
        [target.organizationId],
      );
      return { ...rows[0], files: storage.state.objects.size };
    };
    const before = await counts();

    // #when
    const statuses = await Promise.all(
      FORMATS.map(
        async (format) =>
          (await download(target, accountant, "2026-10", format)).status,
      ),
    );

    // #then
    expect({ statuses, after: await counts() }).toEqual({
      statuses: [200, 200, 200, 200],
      after: before,
    });
  });

  it("refuses an employee every month's download", async () => {
    // #given
    const { company: target, employee } = await company();

    // #when
    const statuses = await Promise.all(
      FORMATS.map(
        async (format) =>
          (await download(target, employee, "2026-10", format)).status,
      ),
    );

    // #then
    expect(statuses).toEqual([403, 403, 403, 403]);
  });

  it("refuses a month or a format it doesn't know", async () => {
    // #given
    const { company: target, accountant } = await company();

    // #when
    const statuses = await Promise.all(
      [
        ["2026-13", "workbook"],
        ["october", "csv"],
        ["2026-10", "pdf"],
      ].map(
        async ([month = "", format = ""]) =>
          (await download(target, accountant, month, format)).status,
      ),
    );

    // #then
    expect(statuses).toEqual([400, 400, 400]);
  });
});

describe("the eTIMS report", () => {
  /**
   * October in Nairobi, with purchases recorded either side of midnight on
   * the 1st, when the UTC date is still the day before.
   */
  async function octoberAcrossTheBoundaries() {
    const seeded = await company();
    const { employeeMembershipId, officeId, seed } = seeded;
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      categoryId: officeId,
      merchant: "September lunch",
      spentOn: "2026-09-30",
      status: "paid",
      paidAt: new Date("2026-09-30T21:00:00Z"),
      createdAt: new Date("2026-09-30T21:00:00Z"),
    });
    await seed.expense({
      categoryId: officeId,
      merchant: "Kenya Power",
      amountKes: 450_000n,
      spentOn: "2026-10-01",
      etimsStatus: "attached",
      etimsInvoiceNumber: "KRAMW0012026100001",
      etimsSupplierPin: "P051234567A",
      createdAt: new Date("2026-09-30T21:00:00Z"),
    });
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      categoryId: officeId,
      merchant: "Kenya Airways",
      amountKes: 2_500_050n,
      spentOn: "2026-10-12",
      status: "rejected",
      rejectedReason: "Personal trip",
      etimsStatus: "not_required",
    });
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      categoryId: officeId,
      merchant: "Matatu fare",
      amountKes: 20_000n,
      spentOn: "2026-10-12",
      status: "submitted",
      etimsStatus: "not_required",
    });
    const float = await seed.openFloat(employeeMembershipId);
    const extra = await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      floatId: float.id,
      categoryId: officeId,
      merchant: "Naivas",
      amountKes: 30_000n,
      spentOn: "2026-10-20",
      status: "submitted",
      etimsStatus: "attached",
      etimsInvoiceNumber: "KRAMW0012026100002",
      etimsSupplierPin: "P059876543B",
    });
    await seed.expense({
      kind: "float",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      floatId: float.id,
      categoryId: officeId,
      merchant: "Naivas",
      amountKes: 70_000n,
      spentOn: "2026-10-20",
      overspendClaimId: extra.id,
    });
    await seed.expense({
      categoryId: officeId,
      merchant: "Imported rent",
      amountKes: 6_000_000n,
      spentOn: "2026-10-25",
      source: "import",
    });
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      categoryId: officeId,
      merchant: "Java House",
      amountKes: 99_999n,
      spentOn: "2026-10-31",
      status: "submitted",
      createdAt: new Date("2026-10-31T20:59:59Z"),
    });
    await seed.expense({
      categoryId: officeId,
      merchant: "November taxi",
      spentOn: "2026-11-01",
      createdAt: new Date("2026-10-31T21:00:00Z"),
    });
    return seeded;
  }

  async function octoberReport(target: TestCompany, user: TestUser) {
    const response = await download(target, user, "2026-10", "etims");
    expect(response.status, await response.clone().text()).toBe(200);
    return parseCsv(await bytesOf(response)).slice(1);
  }

  it("lists each purchase made in the Nairobi month once, with its eTIMS details", async () => {
    // #given
    const { company: target, accountant } = await octoberAcrossTheBoundaries();

    // #when
    const rows = await octoberReport(target, accountant);

    // #then
    expect(rows).toEqual([
      [
        "2026-10-01",
        "Kenya Power",
        "4500.00",
        "Attached",
        "KRAMW0012026100001",
        "P051234567A",
      ],
      ["2026-10-12", "Matatu fare", "200.00", "Not required", "", ""],
      [
        "2026-10-20",
        "Naivas",
        "1000.00",
        "Attached",
        "KRAMW0012026100002",
        "P059876543B",
      ],
      ["2026-10-25", "Imported rent", "60000.00", "", "", ""],
      ["2026-10-31", "Java House", "999.99", "None", "", ""],
    ]);
  });

  it("leaves out a rejected claim", async () => {
    // #given
    const { company: target, accountant } = await octoberAcrossTheBoundaries();

    // #when
    const rows = await octoberReport(target, accountant);

    // #then
    expect(rows.map(([, merchant]) => merchant)).not.toContain("Kenya Airways");
  });

  it("matches the expenses list for the same month less rejected claims, an overspend counted once", async () => {
    // #given
    const { company: target, accountant } = await octoberAcrossTheBoundaries();

    // #when
    const rows = await octoberReport(target, accountant);
    const listed = await sendJson(
      app,
      `/organizations/${target.organizationId}/expenses?month=2026-10&limit=100`,
      accountant,
    );

    // #then
    const { expenses } = expensesPageSchema.parse(
      ((await listed.json()) as { data: unknown }).data,
    );
    const overspendClaims = new Set(
      expenses.map((expense) => expense.overspendClaimId),
    );
    const purchases = expenses
      .filter(
        (expense) =>
          expense.status !== "rejected" && !overspendClaims.has(expense.id),
      )
      .map((expense) => [expense.spentOn, expense.merchant])
      .sort();
    expect(rows.map(([date, merchant]) => [date, merchant]).sort()).toEqual(
      purchases,
    );
  });

  it("keeps each company's expenses out of the other's report", async () => {
    // #given
    const { company: target, accountant } = await octoberAcrossTheBoundaries();
    const other = await company();
    await other.seed.expense({
      categoryId: other.officeId,
      merchant: "Other company's lunch",
      spentOn: "2026-10-15",
    });

    // #when
    const rows = await octoberReport(target, accountant);

    // #then
    expect(rows.map(([, merchant]) => merchant)).not.toContain(
      "Other company's lunch",
    );
  });
});
