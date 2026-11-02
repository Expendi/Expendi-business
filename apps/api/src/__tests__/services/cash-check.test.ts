import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { OverviewCompany } from "../helpers/overview.js";
import { DatabaseService } from "../../db/client.js";
import { bills, payrollRuns } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { checkCash } from "../../services/overview/cash-check.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { makeFakePaycrest } from "../helpers/fakes.js";
import { OVERVIEW_TODAY, seedOverviewCompany } from "../helpers/overview.js";
import { USDC } from "../helpers/payouts.js";
import { addEmployeePayee, insertSalary } from "../helpers/payroll.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(() => runtime.dispose());

/**
 * The fake Paycrest sells at 128.68 KES per USDC, so 100 USDC is worth
 * KES 12,868.00: 1,286,800 cents.
 */
const HUNDRED_USDC_IN_KES = 1_286_800n;

const thirtyDays = (f: OverviewCompany) =>
  runtime.runPromise(
    checkCash({
      organizationId: f.company.organizationId,
      today: OVERVIEW_TODAY,
      days: 30,
    }),
  );

async function fundedCompany(): Promise<OverviewCompany> {
  const f = await seedOverviewCompany(db);
  await f.deposit(100n * USDC);
  return f;
}

describe("checkCash", () => {
  it("is Covered while the 30-day total fits the balance, and Short once a bill pushes it past", async () => {
    // #given bills that add up to exactly the balance, one on the window's last day
    const f = await fundedCompany();
    const bill = { payeeId: f.supplierId, categoryId: f.categoryId };
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 1_000_000n,
      dueOn: "2026-11-20",
    });
    await insertBill(db, f.company, {
      ...bill,
      amountKes: HUNDRED_USDC_IN_KES - 1_000_000n,
      dueOn: "2026-12-02",
    });
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 5_000_000n,
      dueOn: "2026-12-03",
    });

    // #when
    const before = await thirtyDays(f);
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 100n,
      dueOn: OVERVIEW_TODAY,
      status: "due",
    });
    const after = await thirtyDays(f);

    // #then
    expect(before).toMatchObject({
      through: "2026-12-02",
      availableKes: HUNDRED_USDC_IN_KES,
      totalKes: HUNDRED_USDC_IN_KES,
      status: "covered",
      shortKes: 0n,
    });
    expect(after).toMatchObject({
      totalKes: HUNDRED_USDC_IN_KES + 100n,
      status: "short",
      shortKes: 100n,
    });
  });

  it("matches a hand count of what the wallet must pay, each obligation once", async () => {
    // #given
    const f = await fundedCompany();
    const bill = { payeeId: f.supplierId, categoryId: f.categoryId };

    // KES 100.00: overdue, still owed
    const overdue = await insertBill(db, f.company, {
      ...bill,
      amountKes: 10_000n,
      dueOn: "2026-10-20",
      status: "overdue",
    });
    // KES 200.00: its payout failed, so it's owed again
    const failed = await insertBill(db, f.company, {
      ...bill,
      amountKes: 20_000n,
      dueOn: "2026-11-05",
    });
    const failedPayout = await f.insertPayout({
      subjectType: "bill",
      subjectId: failed,
      amountKes: 20_000n,
      status: "failed",
      paidAt: null,
    });
    await setBill(f, failed, {
      status: "payout_failed",
      payoutId: failedPayout.id,
    });
    // Being paid: left out, but its approved payout holds 10 USDC
    const paying = await insertBill(db, f.company, {
      ...bill,
      amountKes: 500_000n,
      dueOn: "2026-11-06",
    });
    const reserving = await f.insertPayout({
      subjectType: "bill",
      subjectId: paying,
      amountKes: 500_000n,
      status: "approved",
      paidAt: null,
      maxDebitUsdc: 10n * USDC,
      quotedUsdc: 10n * USDC,
    });
    await setBill(f, paying, { status: "paying", payoutId: reserving.id });
    // Settled: left out
    const paid = await insertBill(db, f.company, {
      ...bill,
      amountKes: 700_000n,
      dueOn: "2026-11-07",
    });
    const paidPayout = await f.insertPayout({
      subjectType: "bill",
      subjectId: paid,
      amountKes: 700_000n,
    });
    await setBill(f, paid, {
      status: "paid",
      payoutId: paidPayout.id,
      paidOn: OVERVIEW_TODAY,
      paidAt: new Date(),
    });
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 800_000n,
      dueOn: "2026-11-08",
      status: "paid_outside",
      paidOn: OVERVIEW_TODAY,
      paidAt: new Date(),
      markedPaidBy: f.company.admin.id,
    });
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 900_000n,
      dueOn: "2026-11-08",
      status: "cancelled",
      cancelledReason: "Subscription ended",
      cancelledBy: f.company.admin.id,
      cancelledAt: new Date(),
    });
    // 2 USDC at 128.68: KES 257.36
    await insertBill(db, f.company, {
      ...bill,
      currency: "usd",
      amountKes: null,
      amountUsdc: 2n * USDC,
      dueOn: "2026-11-10",
    });
    // Paid outside Expendi: listed, not taken from the wallet
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
    // No amount yet: counted apart
    await insertBill(db, f.company, {
      ...bill,
      variable: true,
      amountKes: null,
      dueOn: "2026-11-09",
    });
    // Payroll on the 28th: KES 600.00 with half already paid, and KES 400.00
    const colleague = await addEmployeePayee(db, f.company, "Baraka");
    const [run] = await runInScope(db, f.tenant, (tx) =>
      tx
        .insert(payrollRuns)
        .values({
          organizationId: f.company.organizationId,
          payDate: "2026-11-28",
          status: "partly_failed",
          totalKes: 100_000n,
          salariesKes: 100_000n,
          capKes: 120_000n,
        })
        .returning(),
    );
    if (!run) throw new Error("run missing");
    const split = await insertBill(db, f.company, {
      payeeId: f.employee.payeeId,
      categoryId: f.categoryId,
      overviewHeading: "salaries",
      payrollRunId: run.id,
      amountKes: 60_000n,
      dueOn: "2026-11-28",
    });
    await f.insertPayout({
      subjectType: "bill",
      subjectId: split,
      payrollRunId: run.id,
      subjectPart: 1,
      amountKes: 30_000n,
    });
    const failedPart = await f.insertPayout({
      subjectType: "bill",
      subjectId: split,
      payrollRunId: run.id,
      subjectPart: 2,
      amountKes: 30_000n,
      status: "failed",
      paidAt: null,
    });
    await setBill(f, split, {
      status: "payout_failed",
      payoutId: failedPart.id,
    });
    await insertBill(db, f.company, {
      payeeId: colleague.payeeId,
      categoryId: f.categoryId,
      overviewHeading: "salaries",
      payrollRunId: run.id,
      amountKes: 40_000n,
      dueOn: "2026-11-28",
    });
    // A salary not drafted yet: KES 500.00 on the 28th
    const latecomer = await addEmployeePayee(db, f.company, "Chebet");
    await insertSalary(db, f.company, {
      payeeId: latecomer.payeeId,
      categoryId: f.categoryId,
      amountKes: 50_000n,
    });
    // KES 10.00 every Monday: today's bill, then four more Mondays
    const weekly = await insertRecurringItem(db, f.company, {
      ...bill,
      amountKes: 1_000n,
      schedule: "weekly",
      scheduleDay: 1,
      nextDueOn: OVERVIEW_TODAY,
    });
    await insertBill(db, f.company, {
      ...bill,
      recurringItemId: weekly,
      amountKes: 1_000n,
      dueOn: OVERVIEW_TODAY,
      status: "due",
    });

    // #when
    const cash = await thirtyDays(f);

    // #then 100 + 200 + 257.36 + (300 + 400) + 500 + 10 + 4 × 10, in cents
    expect(cash.totalKes).toBe(
      10_000n + 20_000n + 25_736n + 70_000n + 50_000n + 1_000n + 4_000n,
    );
    expect(cash).toMatchObject({
      reservedUsdc: 10n * USDC,
      availableKes: (HUNDRED_USDC_IN_KES * 9n) / 10n,
      outsideKes: 300_000n,
      unknownAmounts: 1,
      status: "covered",
    });
    expect(cash.obligations[0]).toMatchObject({
      id: overdue,
      status: "overdue",
    });
    expect(cash.obligations.filter((row) => row.kind === "payroll")).toEqual([
      expect.objectContaining({
        id: run.id,
        amountKes: 70_000n,
        status: "payout_failed",
      }),
    ]);
    expect(
      cash.obligations
        .filter((row) => row.id === weekly)
        .map((row) => row.dueOn),
    ).toEqual(["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
  });

  it("checks a 7-day window from a job with no request", async () => {
    // #given exactly the balance due in 7 days, and more just after
    const f = await fundedCompany();
    const bill = { payeeId: f.supplierId, categoryId: f.categoryId };
    await insertBill(db, f.company, {
      ...bill,
      amountKes: HUNDRED_USDC_IN_KES,
      dueOn: "2026-11-09",
    });
    await insertBill(db, f.company, {
      ...bill,
      amountKes: 100n,
      dueOn: "2026-11-10",
    });

    // #when
    const week = await runtime.runPromise(
      checkCash({
        organizationId: f.company.organizationId,
        today: OVERVIEW_TODAY,
        days: 7,
      }),
    );

    // #then
    expect(week).toMatchObject({
      through: "2026-11-09",
      status: "covered",
      shortKes: 0n,
    });
    expect((await thirtyDays(f)).shortKes).toBe(100n);
  });

  it("can't say Covered or Short without Paycrest's rate, unless nothing is due", async () => {
    // #given
    const paycrest = makeFakePaycrest();
    paycrest.state.failRate = true;
    const offline = makeTestRuntime({ paycrest: paycrest.layer });
    const idle = await fundedCompany();
    const owing = await fundedCompany();
    await insertBill(db, owing.company, {
      payeeId: owing.supplierId,
      categoryId: owing.categoryId,
      amountKes: 100n,
      dueOn: "2026-11-09",
    });
    const check = (f: OverviewCompany) =>
      offline.runPromise(
        checkCash({
          organizationId: f.company.organizationId,
          today: OVERVIEW_TODAY,
          days: 30,
        }),
      );

    try {
      // #when
      const [nothingDue, somethingDue] = [
        await check(idle),
        await check(owing),
      ];

      // #then
      expect(nothingDue).toMatchObject({ status: "covered", shortKes: 0n });
      expect(somethingDue).toMatchObject({
        status: "unknown",
        shortKes: null,
        rate: null,
        availableKes: null,
        totalKes: 100n,
      });
    } finally {
      await offline.dispose();
    }
  });
});

function setBill(
  f: OverviewCompany,
  billId: string,
  values: Partial<typeof bills.$inferInsert>,
) {
  return runInScope(db, f.tenant, (tx) =>
    tx.update(bills).set(values).where(eq(bills.id, billId)),
  );
}
