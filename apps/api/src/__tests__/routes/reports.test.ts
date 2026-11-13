import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { strFromU8, strToU8 } from "fflate";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  exportFileUrlSchema,
  exportListSchema,
  generatedExportSchema,
  reportMonthSummarySchema,
  reportSpendingSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NewBill } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  memberships,
  payrollRuns,
  reportExportLinks,
  reportExports,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import {
  hashExportToken,
  openExportLink,
} from "../../services/export/artifacts.js";
import { readExportData } from "../../services/export/data.js";
import { csvFile, kesDecimal } from "../../services/export/format.js";
import { monthBounds } from "../../services/export/month.js";
import { deliverMonthlyExport } from "../../services/export/monthly.js";
import {
  MONEY_OUT_COLUMNS,
  OUTSTANDING_COLUMNS,
  renderExport,
} from "../../services/export/render.js";
import { getSpendingOverview } from "../../services/overview/overview.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  asAdmin,
  exportSeeder,
  nameUser,
  parseCsv,
  unzip,
} from "../helpers/exports.js";
import {
  FAKE_STORAGE_ORIGIN,
  makeFakeEmailSender,
  makeFakeFileStorage,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const API_PUBLIC_URL = "https://api.expendi.test";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const storage = makeFakeFileStorage();
const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { fileStorage: storage.layer, emailSender: email.layer },
    { API_PUBLIC_URL },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  email.state.reset();
});

const reportsPath = (company: TestCompany, rest = "") =>
  `/organizations/${company.organizationId}/reports${rest}`;

/** A company with its admin named, a wallet, two categories and an employee. */
async function company() {
  const target = await createCompany(db);
  await nameUser(db, target.admin, "Jane Wanjiku");
  const wallet = await createActiveWallet(db, target);
  const employee = await createUser(db);
  await nameUser(db, employee, "Peter Otieno");
  const employeeMembershipId = await addMember(db, target, employee);
  return {
    company: target,
    employee,
    employeeMembershipId,
    officeId: await addCategory(db, target, "Office"),
    rentId: await addCategory(db, target, "Rent"),
    seed: exportSeeder(db, target, wallet.id, storage),
  };
}

function readOctober(target: TestCompany) {
  return runtime.runPromise(
    withScope(asAdmin(target), (tx) =>
      readExportData(tx, target.organizationId, monthBounds("2026-10")),
    ),
  );
}

describe("the month's money out", () => {
  it("counts claims by when they were paid, on Nairobi's month boundaries", async () => {
    // #given
    const {
      company: target,
      employeeMembershipId,
      officeId,
      seed,
    } = await company();
    const firstMinute = await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      categoryId: officeId,
      status: "paid",
      spentOn: "2026-09-28",
      paidAt: new Date("2026-09-30T21:00:00Z"),
    });
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      categoryId: officeId,
      status: "paid",
      paidAt: new Date("2026-10-31T21:00:00Z"),
    });
    await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      categoryId: officeId,
      status: "submitted",
    });

    // #when
    const data = await readOctober(target);

    // #then
    expect(data.moneyOut.map((row) => row.id)).toEqual([firstMinute.id]);
  });

  it("lists petty cash spending and overspend claims, and float issues only as transfers", async () => {
    // #given
    const {
      company: target,
      employeeMembershipId,
      officeId,
      seed,
    } = await company();
    const float = await seed.openFloat(employeeMembershipId);
    const issue = await seed.floatPayment(
      float.id,
      "issue",
      1_000_000n,
      new Date("2026-10-02T06:00:00Z"),
    );
    const extra = await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      floatId: float.id,
      categoryId: officeId,
      amountKes: 30_000n,
      status: "paid",
      paidAt: new Date("2026-10-16T08:00:00Z"),
      mpesaCode: "SLK4H7Q2XY",
    });
    const covered = await seed.expense({
      kind: "float",
      overviewHeading: "petty_cash",
      membershipId: employeeMembershipId,
      floatId: float.id,
      categoryId: officeId,
      amountKes: 70_000n,
      overspendClaimId: extra.id,
    });

    // #when
    const data = await readOctober(target);

    // #then
    expect(
      data.moneyOut.map((row) => [row.kind, row.amountKes, row.mpesaCode]),
    ).toEqual([
      ["claim", 30_000n, "SLK4H7Q2XY"],
      ["float", 70_000n, "SLK4H7Q2XY"],
    ]);
    expect(data.moneyOut.map((row) => row.receiptOwnerId)).toEqual([
      extra.id,
      extra.id,
    ]);
    expect(data.moneyOut.map((row) => row.id)).toContain(covered.id);
    expect(data.floatTransfers.map((row) => [row.id, row.amountKes])).toEqual([
      [issue.movementId, 1_000_000n],
    ]);
  });

  it("lists a bill paid outside once, as the bill, with its spending row's details", async () => {
    // #given
    const { company: target, rentId, seed } = await company();
    const payeeId = await insertPayee(db, target, { name: "Landlord" });
    const { billId } = await seed.paidOutsideBill(
      { payeeId, categoryId: rentId, amountKes: 5_000_000n },
      { mpesaCode: "QWE1RTY2UI" },
    );

    // #when
    const data = await readOctober(target);

    // #then
    expect(
      data.moneyOut.map((row) => [
        row.id,
        row.kind,
        row.amountKes,
        row.status,
        row.mpesaCode,
        row.approvedBy,
      ]),
    ).toEqual([
      [
        billId,
        "bill",
        5_000_000n,
        "paid_outside",
        "QWE1RTY2UI",
        "Jane Wanjiku",
      ],
    ]);
  });

  it("values USD bills in KES from the payout once paid, or the spending row once paid outside", async () => {
    // #given
    const { company: target, officeId, seed } = await company();
    const payeeId = await insertPayee(db, target, { name: "Vercel" });
    const txHash = `0x${"c".repeat(64)}`;
    const paid = await seed.paidBill(
      {
        payeeId,
        categoryId: officeId,
        overviewHeading: "subscriptions",
        currency: "usd",
        amountKes: null,
        amountUsdc: 100_000_000n,
      },
      [
        {
          provider: "onchain",
          method: "usdc",
          recipient: {
            method: "usdc",
            chain: "base",
            address: `0x${"b".repeat(40)}`,
            accountName: "Vercel",
          },
          providerOrderId: null,
          requestedKesCents: 1_290_012n,
          amountKes: 1_290_012n,
          txHash,
        },
      ],
    );
    const outside = await seed.paidOutsideBill(
      {
        payeeId,
        categoryId: officeId,
        overviewHeading: "subscriptions",
        currency: "usd",
        amountKes: null,
        amountUsdc: 100_000_000n,
      },
      { amountKes: 1_300_000n },
    );

    // #when
    const data = await readOctober(target);

    // #then
    const byId = new Map(data.moneyOut.map((row) => [row.id, row]));
    expect(byId.get(paid.billId)?.amountKes).toBe(1_290_012n);
    expect(byId.get(paid.billId)?.payoutReference).toBe(txHash);
    expect(byId.get(outside.billId)?.amountKes).toBe(1_300_000n);
    expect(data.moneyOut).toHaveLength(2);
  });

  describe("the payout reference of a USDC payout", () => {
    const usdcBill = async (
      payout: { txHash: string | null; providerReference: string | null },
      chain: "near" | "base" = "base",
    ) => {
      const { company: target, officeId, seed } = await company();
      const payeeId = await insertPayee(db, target, { name: "Vercel" });
      const paid = await seed.paidBill(
        {
          payeeId,
          categoryId: officeId,
          currency: "usd",
          amountKes: null,
          amountUsdc: 100_000_000n,
        },
        [
          {
            provider: "onchain",
            method: "usdc",
            recipient: {
              method: "usdc",
              chain,
              address: `0x${"b".repeat(40)}`,
              accountName: "Vercel",
            },
            providerOrderId: null,
            requestedKesCents: 1_290_012n,
            amountKes: 1_290_012n,
            ...payout,
          },
        ],
      );
      const data = await readOctober(target);
      return data.moneyOut.find((row) => row.id === paid.billId);
    };

    it("is the payee chain's transaction when the company sent none of its own", async () => {
      // #given a confidential account's payout: no hash, only the delivery
      const delivery = `0x${"d".repeat(64)}`;

      // #when
      const row = await usdcBill({ txHash: null, providerReference: delivery });

      // #then
      expect(row?.payoutReference).toBe(delivery);
    });

    it("stays the company's own transaction, as before, when it has one", async () => {
      // #given
      const own = "6mKzv7RfQ9cYw2PqL8nXbT3jDe4HsUa1VgCoNiEp5MtY";

      // #when
      const row = await usdcBill({
        txHash: own,
        providerReference: `0x${"d".repeat(64)}`,
      });

      // #then
      expect(row?.payoutReference).toBe(own);
    });

    it("is empty while there is neither", async () => {
      // #when
      const row = await usdcBill({ txHash: null, providerReference: null });

      // #then
      expect(row?.payoutReference).toBe("");
    });
  });

  it("lists salaries per person, with every part of a split salary's reference", async () => {
    // #given
    const { company: target, rentId, seed } = await company();
    const [run] = await runInScope(db, asAdmin(target), (tx) =>
      tx
        .insert(payrollRuns)
        .values({
          organizationId: target.organizationId,
          payDate: "2026-10-28",
          status: "paid",
          totalKes: 11_000_000n,
          capKes: 20_000_000n,
        })
        .returning(),
    );
    if (!run) throw new Error("no run");
    const alice = await insertPayee(db, target, {
      kind: "personnel",
      name: "Alice",
    });
    const bob = await insertPayee(db, target, {
      kind: "personnel",
      name: "Bob",
    });
    const salary = {
      categoryId: rentId,
      overviewHeading: "salaries" as const,
      payrollRunId: run.id,
      paidOn: "2026-10-28",
    };
    await seed.paidBill({ ...salary, payeeId: alice, amountKes: 6_000_000n });
    await seed.paidBill({ ...salary, payeeId: bob, amountKes: 5_000_000n }, [
      { providerOrderId: "order-bob-1", providerReference: "RKX1" },
      { providerOrderId: "order-bob-2", providerReference: "RKX2" },
    ]);

    // #when
    const data = await readOctober(target);

    // #then
    expect(
      data.moneyOut.map((row) => [
        row.kind,
        row.person,
        row.amountKes,
        row.merchant,
      ]),
    ).toEqual([
      ["salary", "Alice", 6_000_000n, ""],
      ["salary", "Bob", 5_000_000n, ""],
    ]);
    expect(data.moneyOut[1]?.payoutReference).toBe(
      "order-bob-1 / RKX1; order-bob-2 / RKX2",
    );
  });

  it("lists bills owed at month end as they stood then", async () => {
    // #given
    const { company: target, rentId } = await company();
    const payeeId = await insertPayee(db, target, { name: "Kenya Power" });
    const bill = (values: Partial<NewBill>) =>
      insertBill(db, target, {
        payeeId,
        categoryId: rentId,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        ...values,
      });
    const dueLastDay = await bill({ dueOn: "2026-10-31", status: "due" });
    const paidLater = await bill({
      dueOn: "2026-10-10",
      status: "paid_outside",
      paidOn: "2026-11-02",
      paidAt: new Date("2026-11-02T08:00:00Z"),
      markedPaidBy: target.admin.id,
    });
    const variable = await bill({
      dueOn: "2026-10-25",
      status: "overdue",
      variable: true,
      amountKes: null,
    });
    const cancelledLater = await bill({
      dueOn: "2026-10-20",
      status: "cancelled",
      cancelledReason: "Moved office",
      cancelledBy: target.admin.id,
      cancelledAt: new Date("2026-11-03T08:00:00Z"),
    });
    await bill({
      dueOn: "2026-10-05",
      status: "paid_outside",
      paidOn: "2026-10-06",
      paidAt: new Date("2026-10-06T08:00:00Z"),
      markedPaidBy: target.admin.id,
    });
    await bill({ dueOn: "2026-11-05", status: "upcoming" });
    await bill({
      dueOn: "2026-10-12",
      status: "cancelled",
      cancelledReason: "Duplicate",
      cancelledBy: target.admin.id,
      cancelledAt: new Date("2026-10-20T08:00:00Z"),
    });
    await bill({
      dueOn: "2026-10-30",
      status: "overdue",
      createdAt: new Date("2026-11-02T08:00:00Z"),
    });

    // #when
    const data = await readOctober(target);

    // #then
    expect(data.outstanding.map((row) => row.id)).toEqual([
      paidLater,
      cancelledLater,
      variable,
      dueLastDay,
    ]);
    expect(data.outstanding.find((row) => row.id === variable)?.amountKes).toBe(
      null,
    );
  });
});

describe("the export's files", () => {
  async function octoberWithReceipts() {
    const seeded = await company();
    const { company: target, officeId, rentId, seed } = seeded;
    const kplcOrder = `order-${randomUUID()}`;
    const lunch = await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      categoryId: officeId,
      merchant: "Java House",
      amountKes: 150_000n,
      spentOn: "2026-10-03",
      status: "paid",
      paidAt: new Date("2026-10-04T08:00:00Z"),
      approvedBy: target.admin.id,
      selfApproved: true,
      etimsInvoiceNumber: "INV-1",
      etimsStatus: "attached",
    });
    await seed.receipt({ expenseId: lunch.id });
    await seed.receipt(
      { expenseId: lunch.id },
      { contentType: "image/png", bytes: strToU8("png") },
    );
    const taxi = await seed.expense({
      kind: "company",
      categoryId: officeId,
      merchant: '=HYPERLINK("x")',
      amountKes: 49_950n,
      spentOn: "2026-10-03",
    });
    await seed.receipt(
      { expenseId: taxi.id },
      { sms: "SLK4H7Q2XY Confirmed. Ksh499.50 paid to TAXI." },
    );
    const payeeId = await insertPayee(db, target, { name: "Kenya Power" });
    const power = await seed.paidBill(
      {
        payeeId,
        categoryId: rentId,
        amountKes: 250_000n,
        paidOn: "2026-10-10",
      },
      [{ providerOrderId: kplcOrder, providerReference: "RKX9" }],
    );
    await seed.receipt(
      { billId: power.billId },
      { contentType: "application/pdf", bytes: strToU8("%PDF-1.4") },
    );
    const rendered = await runtime.runPromise(
      renderExport(asAdmin(target), "2026-10"),
    );
    return { ...seeded, rendered, kplcOrder };
  }

  it("writes the main sheet's columns exactly as spec §6.11 lists them, in a UTF-8 CSV with a byte-order mark", async () => {
    // #given
    const { rendered } = await octoberWithReceipts();

    // #when
    const csvs = unzip(rendered.csv);
    const moneyOut = csvs["money-out.csv"] ?? new Uint8Array();

    // #then
    expect([...moneyOut.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(parseCsv(moneyOut)[0]).toEqual([
      "Date",
      "Kind",
      "Overview heading",
      "Payee or employee",
      "Merchant",
      "Category",
      "Amount (KES)",
      "Status",
      "Source",
      "Approved by",
      "Self-approved",
      "M-Pesa code",
      "eTIMS invoice number",
      "eTIMS status",
      "Receipt file",
      "Payout reference",
    ]);
    expect(
      parseCsv(csvs["outstanding-bills.csv"] ?? new Uint8Array())[0],
    ).toEqual([...OUTSTANDING_COLUMNS]);
    expect(Object.keys(csvs).sort()).toEqual([
      "float-transfers.csv",
      "money-out.csv",
      "outstanding-bills.csv",
    ]);
  });

  it("fills the rows: amounts from integer cents, the self-approved flag, eTIMS and payout references", async () => {
    // #given
    const { rendered, kplcOrder } = await octoberWithReceipts();

    // #when
    const rows = parseCsv(
      unzip(rendered.csv)["money-out.csv"] ?? new Uint8Array(),
    ).slice(1);

    // #then
    const column = (name: (typeof MONEY_OUT_COLUMNS)[number]) =>
      MONEY_OUT_COLUMNS.indexOf(name);
    expect(
      rows.map((row) => [
        row[column("Kind")],
        row[column("Overview heading")],
        row[column("Merchant")],
        row[column("Amount (KES)")],
        row[column("Approved by")],
        row[column("Self-approved")],
        row[column("eTIMS status")],
        row[column("Payout reference")],
      ]),
    ).toEqual([
      [
        "Reimbursement",
        "Petty cash",
        "Java House",
        "1500.00",
        "Jane Wanjiku",
        "Yes",
        "Attached",
        "",
      ],
      [
        "Company",
        "Transactions",
        '\'=HYPERLINK("x")',
        "499.50",
        "",
        "No",
        "None",
        "",
      ],
      [
        "Bill",
        "Transactions",
        "Kenya Power",
        "2500.00",
        "Jane Wanjiku",
        "No",
        "",
        `${kplcOrder} / RKX9`,
      ],
    ]);
  });

  it("names every receipt in the zip exactly as the receipt file column does", async () => {
    // #given
    const { rendered } = await octoberWithReceipts();
    const rows = parseCsv(
      unzip(rendered.csv)["money-out.csv"] ?? new Uint8Array(),
    ).slice(1);
    const listed = rows.flatMap((row) =>
      (row[MONEY_OUT_COLUMNS.indexOf("Receipt file")] ?? "")
        .split("; ")
        .filter((name) => name !== ""),
    );

    // #when
    const zipped = unzip(rendered.receipts);

    // #then
    expect(Object.keys(zipped).sort()).toEqual([...listed].sort());
    expect(listed).toEqual([
      "2026-10-03_jane-wanjiku_java-house_1500.jpg",
      "2026-10-03_jane-wanjiku_java-house_1500.png",
      "2026-10-03_hyperlink-x_499.50.txt",
      "2026-10-10_kenya-power_2500.pdf",
    ]);
    expect(
      strFromU8(
        zipped["2026-10-03_hyperlink-x_499.50.txt"] ?? new Uint8Array(),
      ),
    ).toContain("Ksh499.50");
  });

  it("adds a suffix when two receipts would get the same name", async () => {
    // #given
    const { company: target, officeId, seed } = await company();
    for (let i = 0; i < 2; i += 1) {
      const lunch = await seed.expense({
        categoryId: officeId,
        merchant: "Naivas",
      });
      await seed.receipt({ expenseId: lunch.id });
    }

    // #when
    const rendered = await runtime.runPromise(
      renderExport(asAdmin(target), "2026-10"),
    );

    // #then
    expect(Object.keys(unzip(rendered.receipts)).sort()).toEqual([
      "2026-10-15_naivas_1500.jpg",
      "2026-10-15_naivas_1500_2.jpg",
    ]);
  });

  it("makes an Excel workbook with the three sheets and numeric amounts", async () => {
    // #given
    const { rendered } = await octoberWithReceipts();

    // #when
    const parts = unzip(rendered.workbook);

    // #then
    const workbook = strFromU8(parts["xl/workbook.xml"] ?? new Uint8Array());
    expect(
      [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(["Money out", "Outstanding bills", "Float transfers"]);
    const sheet = strFromU8(
      parts["xl/worksheets/sheet1.xml"] ?? new Uint8Array(),
    );
    expect(sheet).toContain('<c r="G2" s="1"><v>1500.00</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">Receipt file</t>');
    expect(parts["[Content_Types].xml"]).toBeDefined();
  });

  it("makes no export when a receipt is missing from storage, rather than leave it out", async () => {
    // #given
    const { company: target, officeId, seed } = await company();
    const lunch = await seed.expense({ categoryId: officeId });
    await seed.receipt({ expenseId: lunch.id }, undefined, { uploaded: false });

    // #when
    const response = await sendJson(
      app,
      reportsPath(target, "/exports"),
      target.admin,
      { method: "POST", body: { month: "2026-10" } },
    );

    // #then
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("A receipt couldn't be read");
    expect(
      await runInScope(db, asAdmin(target), (tx) =>
        tx.select().from(reportExports),
      ),
    ).toEqual([]);
  });

  it("answers that storage is unreachable when R2 is down", async () => {
    // #given
    const { company: target, officeId, seed } = await company();
    const lunch = await seed.expense({ categoryId: officeId });
    await seed.receipt({ expenseId: lunch.id });
    storage.state.failGets = true;

    // #when
    const response = await sendJson(
      app,
      reportsPath(target, "/2026-10/receipts"),
      target.admin,
    ).finally(() => {
      storage.state.failGets = false;
    });

    // #then
    expect(response.status).toBe(503);
  });

  it("formats money from integers and neutralises formulas in CSV text", () => {
    // #when
    const csv = Buffer.from(csvFile([["@SUM(A1)", "-2", 'a,"b"']])).toString(
      "utf8",
    );

    // #then
    expect(kesDecimal(9_007_199_254_740_993_123n)).toBe("90071992547409931.23");
    expect(kesDecimal(5n)).toBe("0.05");
    expect(csv).toBe('\uFEFF"\'@SUM(A1)","\'-2","a,""b"""\r\n');
  });
});

describe("a month's figures", () => {
  async function dataOf(response: Response): Promise<unknown> {
    if (response.status !== 200) {
      throw new Error(`answered ${response.status}: ${await response.text()}`);
    }
    return ((await response.json()) as { data: unknown }).data;
  }

  it("says what each of the month's files holds, read as the files are made", async () => {
    // #given October's money out, receipts, bills owed and a float issued
    const seeded = await company();
    const {
      company: target,
      employeeMembershipId,
      officeId,
      rentId,
      seed,
    } = seeded;
    const lunch = await seed.expense({
      kind: "claim",
      overviewHeading: "petty_cash",
      categoryId: officeId,
      merchant: "Java House",
      amountKes: 150_000n,
      spentOn: "2026-10-03",
      status: "paid",
      paidAt: new Date("2026-10-04T08:00:00Z"),
      approvedBy: target.admin.id,
      etimsInvoiceNumber: "INV-1",
      etimsStatus: "attached",
    });
    await seed.receipt({ expenseId: lunch.id });
    await seed.receipt(
      { expenseId: lunch.id },
      { contentType: "image/png", bytes: strToU8("png") },
    );
    const taxi = await seed.expense({
      categoryId: officeId,
      merchant: "Taxi",
      amountKes: 49_950n,
      spentOn: "2026-10-03",
    });
    await seed.receipt(
      { expenseId: taxi.id },
      { sms: "SLK4H7Q2XY Confirmed. Ksh499.50 paid to TAXI." },
    );
    await seed.expense({
      categoryId: officeId,
      merchant: "Stationery",
      amountKes: 20_000n,
      spentOn: "2026-10-20",
      etimsStatus: "not_required",
    });
    const payeeId = await insertPayee(db, target, { name: "Kenya Power" });
    const power = await seed.paidBill({
      payeeId,
      categoryId: rentId,
      amountKes: 250_000n,
      paidOn: "2026-10-10",
    });
    await seed.receipt(
      { billId: power.billId },
      { contentType: "application/pdf", bytes: strToU8("%PDF-1.4") },
    );
    const float = await seed.openFloat(employeeMembershipId);
    await seed.floatPayment(
      float.id,
      "issue",
      500_000n,
      new Date("2026-10-02T08:00:00Z"),
    );
    const owed = (values: Partial<NewBill>) =>
      insertBill(db, target, {
        payeeId,
        categoryId: rentId,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        ...values,
      });
    await owed({ dueOn: "2026-10-20", status: "overdue", amountKes: 30_000n });
    await owed({
      dueOn: "2026-10-25",
      status: "overdue",
      variable: true,
      amountKes: null,
    });
    await owed({
      dueOn: "2026-10-31",
      status: "due",
      currency: "usd",
      amountKes: null,
      amountUsdc: 45_000_000n,
    });
    const rendered = await runtime.runPromise(
      renderExport(asAdmin(target), "2026-10"),
    );

    // #when
    const summary = reportMonthSummarySchema.parse(
      await dataOf(
        await sendJson(
          app,
          reportsPath(target, "/2026-10/summary"),
          target.admin,
        ),
      ),
    );

    // #then
    expect(summary.moneyOut).toEqual({
      rows: 4,
      importedRows: 0,
      totalKes: "469950",
      preview: [
        {
          date: "2026-10-03",
          kind: "claim",
          name: "Jane Wanjiku",
          amountKes: "150000",
        },
        {
          date: "2026-10-03",
          kind: "company",
          name: "Taxi",
          amountKes: "49950",
        },
        {
          date: "2026-10-10",
          kind: "bill",
          name: "Kenya Power",
          amountKes: "250000",
        },
        {
          date: "2026-10-20",
          kind: "company",
          name: "Stationery",
          amountKes: "20000",
        },
      ],
    });
    expect(summary.outstanding).toEqual({
      rows: 3,
      totalKes: "30000",
      totalUsdc: "45000000",
      overdue: 2,
      withoutAmount: 1,
      preview: [
        {
          dueOn: "2026-10-20",
          payee: "Kenya Power",
          overdue: true,
          amountKes: "30000",
          amountUsdc: null,
        },
        {
          dueOn: "2026-10-25",
          payee: "Kenya Power",
          overdue: true,
          amountKes: null,
          amountUsdc: null,
        },
        {
          dueOn: "2026-10-31",
          payee: "Kenya Power",
          overdue: false,
          amountKes: null,
          amountUsdc: "45000000",
        },
      ],
    });
    expect(summary.floatTransfers).toEqual({
      rows: 1,
      preview: [
        {
          date: "2026-10-02",
          type: "issue",
          person: "Peter Otieno",
          amountKes: "500000",
        },
      ],
    });
    expect({
      ...summary.receipts,
      names: [...summary.receipts.names].sort(),
    }).toEqual({
      files: 4,
      names: Object.keys(unzip(rendered.receipts)).sort(),
      expensesWithout: 1,
      withoutPreview: [
        { date: "2026-10-20", merchant: "Stationery", amountKes: "20000" },
      ],
    });
    expect({
      ...summary.etims,
      preview: summary.etims.preview
        .map(({ merchant, status }) => `${merchant}: ${status}`)
        .sort(),
    }).toEqual({
      rows: 3,
      attached: 1,
      none: 1,
      notRequired: 1,
      preview: [
        "Java House: attached",
        "Stationery: not_required",
        "Taxi: none",
      ],
    });
  });

  it("shows an accountant a month's figures, refuses an employee, and checks the month", async () => {
    // #given
    const { company: target, employee } = await company();
    const accountant = await createUser(db);
    await addMember(db, target, accountant, { role: "accountant" });

    const requests = [
      [accountant, "/2026-10/summary"],
      [employee, "/2026-10/summary"],
      [target.admin, "/2026-13/summary"],
      [accountant, "/spending"],
      [employee, "/spending"],
      [target.admin, "/spending?months=7"],
      [target.admin, "/spending?month=2026-1"],
    ] as const;

    // #when
    const answers = await Promise.all(
      requests.map(
        async ([user, rest]) =>
          (await sendJson(app, reportsPath(target, rest), user)).status,
      ),
    );

    // #then
    expect(answers).toEqual([200, 403, 400, 200, 403, 400, 400]);
  });

  it("adds up money out by month exactly as the spending overview does", async () => {
    // #given payments in September and October, and one in March outside the range
    const {
      company: target,
      employeeMembershipId,
      officeId,
      rentId,
      seed,
    } = await company();
    const payeeId = await insertPayee(db, target, { name: "Kenya Power" });
    await seed.paidBill(
      {
        payeeId,
        categoryId: rentId,
        amountKes: 250_000n,
        paidOn: "2026-10-10",
      },
      [{ amountKes: 250_000n, paidAt: new Date("2026-10-10T09:00:00Z") }],
    );
    await seed.paidBill(
      {
        payeeId,
        categoryId: rentId,
        amountKes: 240_000n,
        paidOn: "2026-09-10",
        overviewHeading: "subscriptions",
      },
      [{ amountKes: 240_000n, paidAt: new Date("2026-09-10T09:00:00Z") }],
    );
    const claim = await seed.expense({
      kind: "claim",
      membershipId: employeeMembershipId,
      overviewHeading: "petty_cash",
      categoryId: officeId,
      merchant: "Java House",
      amountKes: 150_000n,
      spentOn: "2026-10-03",
      status: "paid",
      paidAt: new Date("2026-10-04T08:00:00Z"),
    });
    await seed.payout(claim.id, {
      subjectType: "claim",
      amountKes: 150_000n,
      paidAt: new Date("2026-10-04T08:00:00Z"),
    });
    await seed.expense({
      categoryId: officeId,
      merchant: "Stationery",
      amountKes: 20_000n,
      spentOn: "2026-10-20",
    });
    await seed.expense({
      categoryId: officeId,
      merchant: "Chairs",
      amountKes: 90_000n,
      spentOn: "2026-03-20",
    });
    const tenant = {
      organizationId: target.organizationId,
      userId: target.admin.id,
      membershipId: target.adminMembershipId,
      role: "admin" as const,
    };
    const overview = (month: string) =>
      runtime.runPromise(getSpendingOverview(tenant, month));

    // #when
    const spending = reportSpendingSchema.parse(
      await dataOf(
        await sendJson(
          app,
          reportsPath(target, "/spending?month=2026-10&months=6"),
          target.admin,
        ),
      ),
    );
    const [october, september] = await Promise.all([
      overview("2026-10"),
      overview("2026-09"),
    ]);

    // #then
    expect(spending.months.map((month) => month.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    const byMonth = new Map(
      spending.months.map((month) => [month.month, month]),
    );
    const headingsOf = (view: typeof october) =>
      Object.fromEntries(view.headings.map((row) => [row.id, row.currentKes]));
    expect([byMonth.get("2026-10"), byMonth.get("2026-09")]).toEqual([
      {
        month: "2026-10",
        totalKes: october.currentKes,
        payments: 3,
        headings: headingsOf(october),
      },
      {
        month: "2026-09",
        totalKes: september.currentKes,
        payments: 1,
        headings: headingsOf(september),
      },
    ]);
    expect(october.currentKes).toBe("420000");
    expect(byMonth.get("2026-04")?.totalKes).toBe("0");
    expect(
      spending.categories.map(({ name, months }) => ({
        name,
        totals: months.map((month) => month.totalKes),
      })),
    ).toEqual([
      { name: "Office", totals: ["0", "0", "0", "0", "0", "0", "170000"] },
      { name: "Rent", totals: ["0", "0", "0", "0", "0", "240000", "250000"] },
    ]);
    expect(
      spending.largestPayments.map(({ name, amountKes, kind, personName }) => ({
        name,
        amountKes,
        kind,
        personName,
      })),
    ).toEqual([
      {
        name: "Java House",
        amountKes: "150000",
        kind: "claim",
        personName: "Peter Otieno",
      },
      {
        name: "Stationery",
        amountKes: "20000",
        kind: "company",
        personName: null,
      },
      {
        name: "Kenya Power",
        amountKes: "250000",
        kind: "bill",
        personName: null,
      },
    ]);
  });

  it("keeps each company's spending to itself", async () => {
    const fixture = await createIsolationFixture(db);
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/reports/spending`,
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/reports/2026-10/summary`,
    }));
  });
});

describe("generating and sharing an export", () => {
  async function generate(target: TestCompany, month = "2026-10") {
    const response = await sendJson(
      app,
      reportsPath(target, "/exports"),
      target.admin,
      {
        method: "POST",
        body: { month },
      },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return generatedExportSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
  }

  const tokenOf = (link: string) => new URL(link).pathname.split("/")[3] ?? "";

  it("stores the files privately in R2 and returns links to the API, not to R2", async () => {
    // #given
    const { company: target } = await company();

    // #when
    const generated = await generate(target);

    // #then
    const prefix = `org/${target.organizationId}/exports/${generated.id}/`;
    expect(
      [...storage.state.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort(),
    ).toEqual([
      `${prefix}expendi-2026-10-csv.zip`,
      `${prefix}expendi-2026-10-receipts.zip`,
      `${prefix}expendi-2026-10.xlsx`,
    ]);
    expect(generated.links.receipts).toMatch(
      /^https:\/\/api\.expendi\.test\/downloads\/reports\/[A-Za-z0-9_-]{43}\/receipts$/,
    );
    expect(
      new Date(generated.expiresAt).getTime() -
        new Date(generated.createdAt).getTime(),
    ).toBe(THIRTY_DAYS_MS);
    expect(generated.createdBy).toBe("Jane Wanjiku");
  });

  it("keeps only the link token's hash, salted with its purpose", async () => {
    // #given
    const { company: target } = await company();

    // #when
    const generated = await generate(target);

    // #then
    const token = tokenOf(generated.links.workbook);
    const links = await runInScope(db, asAdmin(target), (tx) =>
      tx
        .select()
        .from(reportExportLinks)
        .where(eq(reportExportLinks.exportId, generated.id)),
    );
    expect(links.map((link) => link.tokenHash)).toEqual([
      hashExportToken(token),
    ]);
    expect(links[0]?.tokenHash).not.toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(links)).not.toContain(token);
  });

  it("audits who generated which month", async () => {
    // #given
    const { company: target } = await company();

    // #when
    const generated = await generate(target);

    // #then
    const { rows } = await owner.query<{ actor_id: string; action: string }>(
      "SELECT actor_id, action FROM audit_log WHERE entity_type = 'report_export' AND entity_id = $1",
      [generated.id],
    );
    expect(rows).toEqual([
      { actor_id: target.admin.id, action: "report_export.generated" },
    ]);
  });

  it("redirects a link to a fresh, short-lived R2 link for that file, without passing the token on", async () => {
    // #given
    const { company: target } = await company();
    const generated = await generate(target);

    // #when
    const response = await app.request(generated.links.receipts);

    // #then
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${FAKE_STORAGE_ORIGIN}/org/${target.organizationId}/exports/${generated.id}/expendi-2026-10-receipts.zip?signature=download`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves a link until exactly 30 days after it was made, then refuses it", async () => {
    // #given
    const { company: target } = await company();
    const generated = await generate(target);
    const token = tokenOf(generated.links.workbook);
    const expiresAt = new Date(generated.expiresAt);

    // #when
    const lastMoment = await runtime.runPromise(
      openExportLink(token, "workbook", new Date(expiresAt.getTime() - 1)),
    );
    const expired = await runtime
      .runPromise(openExportLink(token, "workbook", expiresAt))
      .then(
        () => "opened",
        (error: unknown) => String(error),
      );

    // #then
    expect(lastMoment.url).toContain(
      `/exports/${generated.id}/expendi-2026-10.xlsx`,
    );
    expect(expired).toContain("expired");
  });

  it("refuses a changed, mistyped or unknown token, and a file that isn't part of an export", async () => {
    // #given
    const { company: target } = await company();
    const generated = await generate(target);
    const token = tokenOf(generated.links.csv);
    const base = `${API_PUBLIC_URL}/downloads/reports`;

    // #when
    const statuses = await Promise.all(
      [
        `${base}/${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}/csv`,
        `${base}/${token.slice(1)}/csv`,
        `${base}/${token}/etims`,
        `${base}/${token}/../csv`,
      ].map(async (url) => (await app.request(url)).status),
    );

    // #then
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it("refuses a month that hasn't started", async () => {
    // #given
    const { company: target } = await company();

    // #when
    const response = await sendJson(
      app,
      reportsPath(target, "/exports"),
      target.admin,
      {
        method: "POST",
        body: { month: "2099-01" },
      },
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("lets an accountant list and download exports but not generate one", async () => {
    // #given
    const { company: target } = await company();
    const generated = await generate(target);
    const accountant = await createUser(db);
    await addMember(db, target, accountant, { role: "accountant" });

    // #when
    const list = await sendJson(
      app,
      reportsPath(target, "/exports"),
      accountant,
    );
    const file = await sendJson(
      app,
      reportsPath(target, `/exports/${generated.id}/files/receipts`),
      accountant,
    );
    const fresh = await sendJson(
      app,
      reportsPath(target, "/2026-10/workbook"),
      accountant,
    );
    const create = await sendJson(
      app,
      reportsPath(target, "/exports"),
      accountant,
      {
        method: "POST",
        body: { month: "2026-10" },
      },
    );

    // #then
    expect(
      exportListSchema
        .parse(((await list.json()) as { data: unknown }).data)
        .map((row) => row.id),
    ).toEqual([generated.id]);
    expect(
      exportFileUrlSchema.parse(((await file.json()) as { data: unknown }).data)
        .url,
    ).toContain(`/exports/${generated.id}/expendi-2026-10-receipts.zip`);
    expect(fresh.headers.get("content-disposition")).toBe(
      'attachment; filename="expendi-2026-10.xlsx"',
    );
    expect(create.status).toBe(403);
  });

  it("refuses an employee every report route", async () => {
    // #given
    const { company: target, employee } = await company();
    const generated = await generate(target);

    // #when
    const statuses = await Promise.all(
      [
        { path: "/exports" },
        { path: "/exports", method: "POST", body: { month: "2026-10" } },
        { path: `/exports/${generated.id}/files/workbook` },
        { path: "/2026-10/workbook" },
        { path: "/2026-10/receipts" },
        { path: "/2026-10/etims" },
      ].map(
        async ({ path, method, body }) =>
          (
            await sendJson(app, reportsPath(target, path), employee, {
              method,
              body,
            })
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
  });

  it("keeps each company's exports and links to itself", async () => {
    // #given
    const isolated = await createIsolationFixture(db);
    const generatedA = await generate(isolated.companyA);
    await generate(isolated.companyB);

    // #then
    await expectRouteIsolation(app, isolated, (id) => ({
      path: `/organizations/${id}/reports/exports`,
    }));
    await expectRouteIsolation(app, isolated, (id) => ({
      path: `/organizations/${id}/reports/exports`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month: "2026-10" }),
      },
    }));
    await expectRouteIsolation(app, isolated, (id) => ({
      path: `/organizations/${id}/reports/exports/${generatedA.id}/files/csv`,
    }));
    for (const format of ["workbook", "csv", "receipts", "etims"]) {
      await expectRouteIsolation(app, isolated, (id) => ({
        path: `/organizations/${id}/reports/2026-10/${format}`,
      }));
    }
    await expectTableIsolation(
      isolated,
      "report_exports",
      "organization_id",
      "admin",
    );
    await expectTableIsolation(
      isolated,
      "report_exports",
      "organization_id",
      "accountant",
    );
    await expectTableIsolation(
      isolated,
      "report_export_links",
      "organization_id",
      "admin",
    );
  });

  it("doesn't open company B's export from company A", async () => {
    // #given
    const isolated = await createIsolationFixture(db);
    const generatedB = await generate(isolated.companyB);

    // #when
    const response = await sendJson(
      app,
      reportsPath(isolated.companyA, `/exports/${generatedB.id}/files/csv`),
      isolated.companyA.admin,
    );

    // #then
    expect(response.status).toBe(404);
  });
});

describe("the monthly email to accountants", () => {
  const FIRST_OF_NOVEMBER = new Date("2026-10-31T21:00:00Z");

  async function withAccountants() {
    const seeded = await company();
    const accountants: Record<"active" | "invited" | "removed", TestUser> = {
      active: await createUser(db),
      invited: await createUser(db),
      removed: await createUser(db),
    };
    const membershipIds = {
      active: await addMember(db, seeded.company, accountants.active, {
        role: "accountant",
      }),
      invited: await addMember(db, seeded.company, accountants.invited, {
        role: "accountant",
        status: "invited",
      }),
      removed: await addMember(db, seeded.company, accountants.removed, {
        role: "accountant",
        status: "removed",
      }),
    };
    return { ...seeded, accountants, membershipIds };
  }

  const deliver = (target: TestCompany, now = FIRST_OF_NOVEMBER) =>
    runtime.runPromise(deliverMonthlyExport(target.organizationId, now));

  const sentTo = (address: string) =>
    email.state.sent.filter((message) => message.to === address);

  it("emails last month's export to active and invited accountants, never removed ones", async () => {
    // #given
    const { company: target, accountants } = await withAccountants();

    // #when
    const outcome = await deliver(target);

    // #then
    expect(outcome).toEqual({ created: true, emailed: 2, failed: 0 });
    expect(email.state.sent.map((message) => message.to).sort()).toEqual(
      [accountants.active.email, accountants.invited.email].sort(),
    );
    expect(email.state.sent[0]?.subject).toBe(
      `${target.name}: October 2026 export`,
    );
  });

  it("sends each accountant one email per company and month, however often it runs", async () => {
    // #given
    const { company: target, accountants } = await withAccountants();

    // #when
    await deliver(target);
    await deliver(target);
    await deliver(target, new Date("2026-11-15T09:00:00Z"));

    // #then
    expect(sentTo(accountants.active.email)).toHaveLength(1);
    expect(sentTo(accountants.invited.email)).toHaveLength(1);
    const made = await runInScope(db, asAdmin(target), (tx) =>
      tx.select().from(reportExports),
    );
    expect(made.map((row) => [row.month, row.monthly])).toEqual([
      ["2026-10", true],
    ]);
  });

  it("retries an email that failed on the next run, and only that one", async () => {
    // #given
    const { company: target, accountants } = await withAccountants();
    email.state.failNext();

    // #when
    const first = await deliver(target);
    const second = await deliver(target);
    const third = await deliver(target);

    // #then
    expect(
      [first, second, third].map(({ emailed, failed }) => [emailed, failed]),
    ).toEqual([
      [1, 1],
      [1, 0],
      [0, 0],
    ]);
    expect(sentTo(accountants.active.email)).toHaveLength(1);
    expect(sentTo(accountants.invited.email)).toHaveLength(1);
  });

  it("gives each accountant a working link of their own, which stops when they're removed", async () => {
    // #given
    const {
      company: target,
      accountants,
      membershipIds,
    } = await withAccountants();
    await deliver(target);
    const linkIn = (address: string) =>
      sentTo(address)[0]?.text.match(/https:\/\/\S+\/workbook/)?.[0] ?? "";
    const activeLink = linkIn(accountants.active.email);
    const invitedLink = linkIn(accountants.invited.email);

    // #when
    const before = (await app.request(activeLink)).status;
    await runInScope(db, asAdmin(target), (tx) =>
      tx
        .update(memberships)
        .set({ status: "removed" })
        .where(eq(memberships.id, membershipIds.active)),
    );
    const after = (await app.request(activeLink)).status;

    // #then
    expect(activeLink).not.toBe(invitedLink);
    expect([before, after, (await app.request(invitedLink)).status]).toEqual([
      302, 404, 302,
    ]);
  });

  it("does nothing for a company without accountants", async () => {
    // #given
    const { company: target } = await company();

    // #when
    const outcome = await deliver(target);

    // #then
    expect(outcome).toEqual({ created: false, emailed: 0, failed: 0 });
    expect(email.state.sent).toEqual([]);
  });

  it("covers the month that just ended in Nairobi", async () => {
    // #given
    const { company: target } = await withAccountants();

    // #when
    await deliver(target, new Date("2026-10-31T20:59:00Z"));

    // #then
    const [made] = await runInScope(db, asAdmin(target), (tx) =>
      tx.select().from(reportExports),
    );
    expect(made?.month).toBe("2026-09");
  });
});
