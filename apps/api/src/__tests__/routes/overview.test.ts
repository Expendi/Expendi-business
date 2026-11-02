import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  overviewPersonSchema,
  spendingOverviewSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { OverviewCompany } from "../helpers/overview.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  bills,
  floatMovements,
  floats,
  payrollRuns,
  receiptFiles,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { getSpendingOverview } from "../../services/overview/overview.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import { makeFakePaycrest } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import {
  OVERVIEW_NOW,
  OVERVIEW_TODAY,
  seedOverviewCompany,
} from "../helpers/overview.js";
import { USDC } from "../helpers/payouts.js";
import { addEmployeePayee, insertSalary } from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(() => runtime.dispose());

const overviewOf = (f: OverviewCompany, month = "2026-11") =>
  runtime.runPromise(getSpendingOverview(f.tenant, month, OVERVIEW_NOW));

async function insertFloat(f: OverviewCompany, membershipId: string) {
  const [float] = await runInScope(db, f.tenant, (tx) =>
    tx
      .insert(floats)
      .values({ organizationId: f.company.organizationId, membershipId })
      .returning(),
  );
  if (!float) throw new Error("float insert returned no row");
  return float;
}

/** A float issue of `amountKes`, paid through Expendi. */
async function issueFloat(
  f: OverviewCompany,
  floatId: string,
  amountKes: bigint,
) {
  const movementId = randomUUID();
  const payout = await f.insertPayout({
    subjectType: "float",
    subjectId: movementId,
    amountKes,
  });
  await runInScope(db, f.tenant, (tx) =>
    tx.insert(floatMovements).values({
      id: movementId,
      organizationId: f.company.organizationId,
      floatId,
      type: "issue",
      status: "paid",
      amountKes,
      payoutId: payout.id,
      recordedBy: f.company.admin.id,
      paidAt: OVERVIEW_NOW,
    }),
  );
}

async function insertPayrollRun(f: OverviewCompany, payDate: string) {
  const [run] = await runInScope(db, f.tenant, (tx) =>
    tx
      .insert(payrollRuns)
      .values({
        organizationId: f.company.organizationId,
        payDate,
        totalKes: 60_000n,
        salariesKes: 60_000n,
        capKes: 72_000n,
      })
      .returning(),
  );
  if (!run) throw new Error("payroll run insert returned no row");
  return run;
}

function settleBill(
  f: OverviewCompany,
  billId: string,
  values: Partial<typeof bills.$inferInsert>,
) {
  return runInScope(db, f.tenant, (tx) =>
    tx.update(bills).set(values).where(eq(bills.id, billId)),
  );
}

describe("spending overview totals", () => {
  it("match a hand count over every kind of spending, each counted once", async () => {
    // #given every kind of money out in November, amounts in KES cents
    const f = await seedOverviewCompany(db);
    // A claim paid through Expendi: 2,000 (Petty cash)
    const claim = await f.insertExpense({
      kind: "claim",
      status: "paid",
      overviewHeading: "petty_cash",
      amountKes: 2_000n,
    });
    await f.insertPayout({
      subjectType: "claim",
      subjectId: claim.id,
      amountKes: 2_000n,
    });
    // A float of 90,000 handed out (not spending), 3,000 spent from it and
    // a 400 claim over it (Petty cash)
    const float = await insertFloat(f, f.employee.membershipId);
    await issueFloat(f, float.id, 90_000n);
    await f.insertExpense({
      kind: "float",
      floatId: float.id,
      amountKes: 3_000n,
    });
    const overspend = await f.insertExpense({
      kind: "claim",
      status: "paid",
      floatId: float.id,
      amountKes: 400n,
    });
    await f.insertPayout({
      subjectType: "claim",
      subjectId: overspend.id,
      amountKes: 400n,
    });
    // Company spending: 5,000 (Transactions)
    await f.insertExpense({ amountKes: 5_000n });
    // A claim imported as paid before Expendi: 900 (Transactions)
    await f.insertExpense({
      kind: "claim",
      status: "paid_outside",
      source: "import",
      amountKes: 900n,
    });
    // A USD bill marked paid outside, recorded at 12,300: counted once
    const outside = await insertBill(db, f.company, {
      payeeId: f.supplierId,
      categoryId: f.categoryId,
      currency: "usd",
      amountKes: null,
      amountUsdc: USDC,
      overviewHeading: "subscriptions",
      status: "paid_outside",
      paidOn: OVERVIEW_TODAY,
      paidAt: OVERVIEW_NOW,
      markedPaidBy: f.company.admin.id,
    });
    await f.insertExpense({
      billId: outside,
      overviewHeading: "subscriptions",
      amountKes: 12_300n,
    });
    // A USD bill paid through Expendi at 24,000 on the day (Subscriptions)
    const usd = await insertBill(db, f.company, {
      payeeId: f.supplierId,
      categoryId: f.categoryId,
      currency: "usd",
      amountKes: null,
      amountUsdc: 2n * USDC,
      overviewHeading: "subscriptions",
    });
    const usdPayout = await f.insertPayout({
      subjectType: "bill",
      subjectId: usd,
      amountKes: 24_000n,
    });
    await settleBill(f, usd, {
      status: "paid",
      payoutId: usdPayout.id,
      paidAt: OVERVIEW_NOW,
      paidOn: OVERVIEW_TODAY,
    });
    // A salary of 60,000 paid in two parts; a failed attempt never counts
    const run = await insertPayrollRun(f, OVERVIEW_TODAY);
    const salary = await insertBill(db, f.company, {
      payeeId: f.employee.payeeId,
      categoryId: f.categoryId,
      overviewHeading: "salaries",
      amountKes: 60_000n,
      payrollRunId: run.id,
    });
    for (const subjectPart of [1, 2]) {
      await f.insertPayout({
        subjectType: "bill",
        subjectId: salary,
        amountKes: 30_000n,
        subjectPart,
        payrollRunId: run.id,
      });
    }
    await f.insertPayout({
      subjectType: "bill",
      subjectId: salary,
      amountKes: 999_900n,
      subjectPart: 3,
      payrollRunId: run.id,
      status: "failed",
      paidAt: null,
    });
    // Waiting for approval: not money out yet
    await f.insertExpense({
      kind: "claim",
      status: "submitted",
      amountKes: 7_777n,
    });
    // Nairobi midnight: 600 on 1 Nov counts now, 800 a second earlier and
    // 700 spent on 31 Oct count last month
    const boundary = await f.insertExpense({ kind: "claim", status: "paid" });
    await f.insertPayout({
      subjectType: "claim",
      subjectId: boundary.id,
      amountKes: 600n,
      paidAt: new Date("2026-10-31T21:00:00Z"),
    });
    const prior = await f.insertExpense({ kind: "claim", status: "paid" });
    await f.insertPayout({
      subjectType: "claim",
      subjectId: prior.id,
      amountKes: 800n,
      paidAt: new Date("2026-10-31T20:59:59Z"),
    });
    await f.insertExpense({ amountKes: 700n, spentOn: "2026-10-31" });
    // Another company's spending
    const other = await seedOverviewCompany(db);
    await other.insertExpense({ amountKes: 99_999_999n });

    // #when
    const overview = await overviewOf(f);

    // #then
    expect({
      current: overview.currentKes,
      previous: overview.previousKes,
      headings: overview.headings.map((row) => [row.id, row.currentKes]),
    }).toEqual({
      // 2,000 + 3,000 + 400 + 5,000 + 900 + 12,300 + 24,000 + 60,000 + 600
      current: "108200",
      // 800 + 700
      previous: "1500",
      headings: [
        ["petty_cash", "5400"],
        ["transactions", "6500"],
        ["salaries", "60000"],
        ["subscriptions", "36300"],
      ],
    });
    expect(overview.categories).toEqual([
      {
        id: f.categoryId,
        name: "Office",
        currentKes: "108200",
        previousKes: "1500",
      },
    ]);
    expect(
      overview.recentPayments.filter((row) => row.subjectId === outside),
    ).toEqual([expect.objectContaining({ kind: "bill", channel: "outside" })]);
    expect(
      overview.recentPayments.filter((row) => row.kind === "float"),
    ).toEqual([
      expect.objectContaining({ amountKes: "3000", channel: "float" }),
    ]);
  });

  it("keeps the month's totals during a Paycrest outage and leaves the cash check unknown", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    await f.deposit(100n * USDC);
    await f.insertExpense({ amountKes: 12_300n });
    await insertBill(db, f.company, {
      payeeId: f.supplierId,
      categoryId: f.categoryId,
      amountKes: 100n,
      dueOn: "2026-11-09",
    });
    const paycrest = makeFakePaycrest();
    paycrest.state.failRate = true;
    const offline = makeTestRuntime({ paycrest: paycrest.layer });

    try {
      // #when
      const overview = await offline.runPromise(
        getSpendingOverview(f.tenant, "2026-11", OVERVIEW_NOW),
      );

      // #then
      expect(overview.currentKes).toBe("12300");
      expect(overview.cash).toMatchObject({
        status: "unknown",
        rate: null,
        balanceKes: null,
        availableKes: null,
        shortKes: null,
        balanceUsdc: (100n * USDC).toString(),
      });
    } finally {
      await offline.dispose();
    }
  });
});

describe("what the overview shows as outstanding and due", () => {
  it("lists overdue and due-today bills, but no forecasts, and the cash check over 30 days", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    await f.deposit(100n * USDC);
    const bill = { payeeId: f.supplierId, categoryId: f.categoryId };
    const overdue = await insertBill(db, f.company, {
      ...bill,
      amountKes: 10_000n,
      dueOn: "2026-10-30",
      status: "overdue",
    });
    const today = await insertBill(db, f.company, {
      ...bill,
      amountKes: 20_000n,
      dueOn: OVERVIEW_TODAY,
      status: "due",
    });
    await insertSalary(db, f.company, {
      payeeId: f.employee.payeeId,
      categoryId: f.categoryId,
      amountKes: 60_000n,
    });

    // #when
    const overview = await overviewOf(f);

    // #then
    expect({
      overdue: overview.outstanding.overdue.map((row) => row.id),
      dueToday: overview.outstanding.dueToday.map((row) => row.id),
      next: overview.cash.obligations.map((row) => [row.kind, row.dueOn]),
      totalKes: overview.cash.totalKes,
      status: overview.cash.status,
    }).toEqual({
      overdue: [overdue],
      dueToday: [today],
      next: [
        ["bill", "2026-10-30"],
        ["bill", OVERVIEW_TODAY],
        ["forecast", "2026-11-28"],
      ],
      totalKes: "90000",
      status: "covered",
    });
  });

  it("gives what's due outside Expendi beside the cash check, never counted against the wallet", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    await f.deposit(100n * USDC);
    await insertBill(db, f.company, {
      payeeId: f.supplierId,
      categoryId: f.categoryId,
      amountKes: 20_000n,
      dueOn: "2026-11-09",
    });
    const cardOnly = await insertPayee(db, f.company, {
      kind: "vendor",
      name: "Card subscription",
      method: "outside",
    });
    await insertBill(db, f.company, {
      payeeId: cardOnly,
      categoryId: f.categoryId,
      amountKes: 300_000n,
      dueOn: "2026-11-15",
      overviewHeading: "subscriptions",
    });

    // #when
    const { cash } = spendingOverviewSchema.parse(await overviewOf(f));

    // #then
    expect({ totalKes: cash.totalKes, outsideKes: cash.outsideKes }).toEqual({
      totalKes: "20000",
      outsideKes: "300000",
    });
  });

  it("lists claims waiting for approval and petty cash without a receipt, its overspend claim's receipt included", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    const float = await insertFloat(f, f.employee.membershipId);
    const waiting = await f.insertExpense({
      kind: "claim",
      status: "submitted",
      floatId: float.id,
    });
    await f.insertExpense({
      kind: "claim",
      status: "rejected",
      rejectedReason: "No",
    });
    await f.insertExpense({
      kind: "float",
      floatId: float.id,
      overspendClaimId: waiting.id,
    });
    const missing = await f.insertExpense({ kind: "float", floatId: float.id });
    await runInScope(db, f.tenant, (tx) =>
      tx.insert(receiptFiles).values({
        organizationId: f.company.organizationId,
        expenseId: waiting.id,
        uploadedBy: f.employee.user.id,
        kind: "sms_text",
        smsText: "Receipt evidence",
        sha256: "a".repeat(64),
        contentType: "text/plain",
        byteSize: 16,
      }),
    );

    // #when
    const { outstanding } = await overviewOf(f);

    // #then
    expect({
      claims: outstanding.claims.map((row) => row.id),
      noReceipt: outstanding.noReceipt.map((row) => row.id),
    }).toEqual({ claims: [waiting.id], noReceipt: [missing.id] });
  });
});

describe("GET /organizations/:organizationId/overview", () => {
  it("gives an accountant the admin's overview, and each person's salary, payments, claims and float", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    const accountant = await createUser(db);
    await addMember(db, f.company, accountant, { role: "accountant" });
    await insertSalary(db, f.company, {
      payeeId: f.employee.payeeId,
      categoryId: f.categoryId,
    });
    await f.insertExpense({ kind: "claim", status: "submitted" });
    const paidClaim = await f.insertExpense({ kind: "claim", status: "paid" });
    await f.insertPayout({ subjectType: "claim", subjectId: paidClaim.id });
    const float = await insertFloat(f, f.employee.membershipId);
    await issueFloat(f, float.id, 10_000n);
    await f.insertExpense({
      kind: "float",
      floatId: float.id,
      amountKes: 3_000n,
    });
    // Recorded by the admin, but a payment to nobody
    await f.insertExpense({ membershipId: f.company.adminMembershipId });
    const path = `/organizations/${f.company.organizationId}/overview`;

    // #when
    const asAdmin = await sendJson(app, path, f.company.admin);
    const asAccountant = await sendJson(app, path, accountant);
    const person = async (personId: string) => {
      const response = await sendJson(
        app,
        `${path}/people/${personId}`,
        accountant,
      );
      const body = (await response.json()) as { data: unknown };
      return overviewPersonSchema.parse(body.data);
    };
    const amina = await person(f.employee.membershipId);
    const admin = await person(f.company.adminMembershipId);

    // #then
    expect(asAccountant.status).toBe(200);
    expect(await asAccountant.json()).toEqual(await asAdmin.json());
    expect({
      name: amina.name,
      salaries: amina.salaries.map((row) => row.amountKes),
      payments: amina.payments.map((row) => row.subjectId),
      claims: amina.claims.length,
      floats: amina.floats.map((row) => row.leftKes),
    }).toEqual({
      name: f.employee.user.email,
      salaries: ["5000000"],
      payments: [paidClaim.id],
      claims: 2,
      floats: ["7000"],
    });
    expect(admin.payments).toEqual([]);
  });

  it("refuses employees; their home reads hold only their own claims, floats and salary payments", async () => {
    // #given
    const f = await seedOverviewCompany(db);
    const colleague = await addEmployeePayee(db, f.company, "Colleague");
    const mine = await f.insertExpense({ kind: "claim", status: "submitted" });
    const theirs = await f.insertExpense({
      kind: "claim",
      status: "submitted",
      membershipId: colleague.membershipId,
    });
    const myFloat = await insertFloat(f, f.employee.membershipId);
    const theirFloat = await insertFloat(f, colleague.membershipId);
    const run = await insertPayrollRun(f, OVERVIEW_TODAY);
    const salaryBills: string[] = [];
    for (const person of [f.employee, colleague]) {
      const billId = await insertBill(db, f.company, {
        payeeId: person.payeeId,
        categoryId: f.categoryId,
        overviewHeading: "salaries",
        payrollRunId: run.id,
        amountKes: 1_000n,
      });
      const payout = await f.insertPayout({
        subjectType: "bill",
        subjectId: billId,
        payrollRunId: run.id,
      });
      await settleBill(f, billId, {
        status: "paid",
        payoutId: payout.id,
        paidOn: OVERVIEW_TODAY,
        paidAt: OVERVIEW_NOW,
      });
      salaryBills.push(billId);
    }
    const drafted = await insertBill(db, f.company, {
      payeeId: f.employee.payeeId,
      categoryId: f.categoryId,
      overviewHeading: "salaries",
      payrollRunId: run.id,
      amountKes: 1_000n,
    });
    const base = `/organizations/${f.company.organizationId}`;
    const read = (path: string) =>
      sendJson(app, `${base}${path}`, f.employee.user);

    // #when
    const refused = [
      (await read("/overview")).status,
      (await read(`/overview/people/${colleague.membershipId}`)).status,
      (await read(`/overview/people/${f.employee.membershipId}`)).status,
    ];
    const claims = await (await read("/claims")).text();
    const myFloats = await (await read("/floats?mine=true")).text();
    const allFloats = await (await read("/floats")).text();
    const salaryPayments = await (await read("/me/salary-payments")).text();

    // #then
    expect(refused).toEqual([403, 403, 403]);
    expect({
      claims: [claims.includes(mine.id), claims.includes(theirs.id)],
      floats: [
        myFloats.includes(myFloat.id),
        myFloats.includes(theirFloat.id),
        allFloats.includes(theirFloat.id),
      ],
      salary: [
        salaryPayments.includes(salaryBills[0] ?? "missing"),
        salaryPayments.includes(salaryBills[1] ?? "missing"),
        salaryPayments.includes(drafted),
      ],
    }).toEqual({
      claims: [true, false],
      floats: [true, false, false],
      salary: [true, false, false],
    });
  });

  it("isolates both routes, hides another company's people and validates the month", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    const path = `/organizations/${fixture.companyA.organizationId}/overview`;

    // #when
    for (const suffix of [
      "",
      `/people/${fixture.companyA.adminMembershipId}`,
    ]) {
      await expectRouteIsolation(app, fixture, (id) => ({
        path: `/organizations/${id}/overview${suffix}`,
      }));
    }
    const foreignPerson = await sendJson(
      app,
      `${path}/people/${fixture.companyB.adminMembershipId}`,
      fixture.companyA.admin,
    );
    const notAnId = await sendJson(
      app,
      `${path}/people/nope`,
      fixture.companyA.admin,
    );
    const badMonth = await sendJson(
      app,
      `${path}?month=2026-13`,
      fixture.companyA.admin,
    );
    const chosen = await sendJson(
      app,
      `${path}?month=2026-10`,
      fixture.companyA.admin,
    );
    const body = (await chosen.json()) as { data: unknown };

    // #then
    expect([foreignPerson.status, notAnId.status, badMonth.status]).toEqual([
      404, 404, 400,
    ]);
    expect(spendingOverviewSchema.parse(body.data)).toMatchObject({
      month: "2026-10",
      previousMonth: "2026-09",
    });
  });
});
