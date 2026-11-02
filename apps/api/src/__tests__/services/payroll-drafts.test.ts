import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import {
  bills,
  organizations,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { payrollCapKes } from "../../services/payroll/cap.js";
import { draftDateFor } from "../../services/payroll/dates.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { nextPayDateOnNewDay } from "../../services/payroll/salaries.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  addEmployeePayee,
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  readSalary,
  runsOf,
  setRunStatus,
  settlePayrollBill,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;

let company: TestCompany;
let categoryId: string;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  company = await createCompany(db);
  categoryId = await addCategory(db, company, "Salaries");
});

/** Nairobi is UTC+3: 21:00 UTC is midnight in Nairobi, the next day. */
const NOV_22_LAST_SECOND_EAT = new Date("2026-11-22T20:59:59Z");
const NOV_23_MIDNIGHT_EAT = new Date("2026-11-22T21:00:00Z");

const asAdmin = () => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

const draft = (now: Date, target: TestCompany = company) =>
  runtime.runPromise(draftDuePayroll(target.organizationId, now));

async function salaryFor(
  values: Partial<Parameters<typeof insertSalary>[2]> = {},
): Promise<{ salaryId: string; payeeId: string }> {
  const { payeeId } = await addEmployeePayee(db, company);
  const salaryId = await insertSalary(db, company, {
    payeeId,
    categoryId,
    ...values,
  });
  return { salaryId, payeeId };
}

async function auditOf(action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    before: unknown;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_type, actor_id, before, after FROM audit_log WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at",
    [company.organizationId, action],
  );
  return rows;
}

describe("when a run is drafted", () => {
  it("drafts nothing until it's 5 days before pay day in Nairobi", async () => {
    // #given a salary paid on 28 Nov
    await salaryFor();

    // #when it's 23:59:59 on 22 Nov in Nairobi
    await draft(NOV_22_LAST_SECOND_EAT);

    // #then
    expect(await runsOf(db, company)).toEqual([]);
  });

  it("drafts the run at midnight in Nairobi 5 days before pay day, while it's still the day before in UTC", async () => {
    // #given
    await salaryFor();

    // #when it's 00:00 on 23 Nov in Nairobi, 21:00 on 22 Nov in UTC
    await draft(NOV_23_MIDNIGHT_EAT);

    // #then
    expect(await runsOf(db, company)).toMatchObject([
      { payDate: "2026-11-28", status: "draft" },
    ]);
  });

  it("puts every active salary in, one bill each at their net pay, and nobody ended, paused or archived", async () => {
    // #given two active salaries, one personnel, and three who mustn't be paid
    const amina = await salaryFor({ amountKes: 6_000_000n });
    const brian = await salaryFor({ amountKes: 4_500_050n });
    const casualId = await insertPersonnelPayee(db, company);
    const casualSalaryId = await insertSalary(db, company, {
      payeeId: casualId,
      categoryId,
      amountKes: 1_500_000n,
    });
    await salaryFor({ nextDueOn: null, endsOn: "2026-10-31" });
    await salaryFor({ active: false });
    const archived = await salaryFor();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(payees)
        .set({ archived: true })
        .where(eq(payees.id, archived.payeeId)),
    );

    // #when
    await draft(NOV_23_MIDNIGHT_EAT);

    // #then
    const [run] = await runsOf(db, company);
    const runBills = await billsOfRun(db, company, run?.id ?? "");
    expect(
      runBills.map((bill) => ({
        payeeId: bill.payeeId,
        salaryId: bill.recurringItemId,
        amountKes: bill.amountKes,
        heading: bill.overviewHeading,
        dueOn: bill.dueOn,
        status: bill.status,
      })),
    ).toEqual([
      {
        payeeId: casualId,
        salaryId: casualSalaryId,
        amountKes: 1_500_000n,
        heading: "salaries",
        dueOn: "2026-11-28",
        status: "upcoming",
      },
      {
        payeeId: brian.payeeId,
        salaryId: brian.salaryId,
        amountKes: 4_500_050n,
        heading: "salaries",
        dueOn: "2026-11-28",
        status: "upcoming",
      },
      {
        payeeId: amina.payeeId,
        salaryId: amina.salaryId,
        amountKes: 6_000_000n,
        heading: "salaries",
        dueOn: "2026-11-28",
        status: "upcoming",
      },
    ]);
  });

  it("sets the cap to the salaries plus the company's margin, and the total to what it pays", async () => {
    // #given KES 80,000.50 of salaries and a 15% margin
    await salaryFor({ amountKes: 5_000_000n });
    await salaryFor({ amountKes: 3_000_050n });
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(organizations)
        .set({ payrollCapMarginPct: 15 })
        .where(eq(organizations.id, company.organizationId)),
    );

    // #when
    await draft(NOV_23_MIDNIGHT_EAT);

    // #then 8,000,050 × 1.15 = 9,200,057.5 cents, rounded down
    expect(await runsOf(db, company)).toMatchObject([
      { salariesKes: 8_000_050n, capKes: 9_200_057n, totalKes: 8_000_050n },
    ]);
  });

  it("moves each salary on to its next pay date", async () => {
    // #given
    const { salaryId } = await salaryFor();

    // #when
    await draft(NOV_23_MIDNIGHT_EAT);

    // #then
    expect((await readSalary(db, company, salaryId)).nextDueOn).toBe(
      "2026-12-28",
    );
  });

  it("audits the draft as the system, with every payment", async () => {
    // #given
    await salaryFor({ amountKes: 5_000_000n });

    // #when
    await draft(NOV_23_MIDNIGHT_EAT);

    // #then
    const [entry] = await auditOf("payroll_run.drafted");
    expect(entry).toMatchObject({
      actor_type: "system",
      actor_id: "payroll-drafts",
      after: {
        payDate: "2026-11-28",
        marginPct: 20,
        salariesKes: "5000000",
        capKes: "6000000",
        totalKes: "5000000",
        payments: [{ amountKes: "5000000" }],
      },
    });
  });
});

describe("exactly once", () => {
  it("leaves one run with one bill each when drafting runs again", async () => {
    // #given
    await salaryFor();
    await salaryFor();
    await draft(NOV_23_MIDNIGHT_EAT);

    // #when
    await draft(new Date("2026-11-24T06:00:00Z"));

    // #then
    const runs = await runsOf(db, company);
    expect({
      runs: runs.length,
      bills: (await billsOfRun(db, company, runs[0]?.id ?? "")).length,
    }).toEqual({ runs: 1, bills: 2 });
  });

  it("leaves one run with one bill each when two drafts race", async () => {
    // #given
    await salaryFor();
    await salaryFor();

    // #when
    await Promise.all([
      draft(NOV_23_MIDNIGHT_EAT),
      draft(NOV_23_MIDNIGHT_EAT),
      draft(NOV_23_MIDNIGHT_EAT),
    ]);

    // #then
    const runs = await runsOf(db, company);
    expect({
      runs: runs.length,
      bills: (await billsOfRun(db, company, runs[0]?.id ?? "")).length,
    }).toEqual({ runs: 1, bills: 2 });
  });

  it("adds a salary due on the same pay date to the draft already there, raising its cap", async () => {
    // #given a run drafted on 23 Nov with one person
    await salaryFor({ amountKes: 5_000_000n });
    await draft(NOV_23_MIDNIGHT_EAT);

    // #when someone joins on 25 Nov, paid on the 28th too
    await salaryFor({ amountKes: 2_000_000n });
    await draft(new Date("2026-11-25T06:00:00Z"));

    // #then
    const runs = await runsOf(db, company);
    expect(
      runs.map((run) => ({
        payDate: run.payDate,
        salariesKes: run.salariesKes,
        capKes: run.capKes,
        totalKes: run.totalKes,
      })),
    ).toEqual([
      {
        payDate: "2026-11-28",
        salariesKes: 7_000_000n,
        capKes: 8_400_000n,
        totalKes: 7_000_000n,
      },
    ]);
  });

  it("doesn't put someone left out back into the run", async () => {
    // #given a draft where the only person was left out
    const { salaryId } = await salaryFor();
    await draft(NOV_23_MIDNIGHT_EAT);
    const [run] = await runsOf(db, company);
    const [bill] = await billsOfRun(db, company, run?.id ?? "");
    await runInScope(db, asAdmin(), async (tx) => {
      await tx
        .update(bills)
        .set({
          status: "cancelled",
          cancelledReason: "Unpaid leave",
          cancelledBy: company.admin.id,
          cancelledAt: new Date(),
        })
        .where(eq(bills.id, bill?.id ?? ""));
      await tx
        .update(recurringItems)
        .set({ nextDueOn: "2026-11-28" })
        .where(eq(recurringItems.id, salaryId));
    });

    // #when the salary is somehow due on that date again
    await draft(new Date("2026-11-24T06:00:00Z"));

    // #then
    expect(
      (await billsOfRun(db, company, run?.id ?? "")).map((row) => row.status),
    ).toEqual(["cancelled"]);
  });

  it("skips a pay date whose run was already approved, audited, rather than drafting it again", async () => {
    // #given an approved run for 28 Nov, and a salary still due that day
    await salaryFor();
    await draft(NOV_23_MIDNIGHT_EAT);
    const [run] = await runsOf(db, company);
    await setRunStatus(db, company, run?.id ?? "", "paying");
    const { salaryId } = await salaryFor();

    // #when
    await draft(new Date("2026-11-26T06:00:00Z"));

    // #then
    expect({
      runs: (await runsOf(db, company)).length,
      bills: (await billsOfRun(db, company, run?.id ?? "")).length,
      nextDueOn: (await readSalary(db, company, salaryId)).nextDueOn,
      audited: (await auditOf("salary.pay_date_skipped")).length,
    }).toEqual({ runs: 1, bills: 1, nextDueOn: "2026-12-28", audited: 1 });
  });

  it("drafts next month's run for someone whose last salary payment failed and is still to be retried", async () => {
    // #given November's payment failed, and December's draft is due
    const { salaryId, payeeId } = await salaryFor();
    await draft(NOV_23_MIDNIGHT_EAT);
    const [november] = await runsOf(db, company);
    const [bill] = await billsOfRun(db, company, november?.id ?? "");
    const wallet = await createActiveWallet(db, company);
    if (!bill) throw new Error("no November bill");
    await settlePayrollBill(db, company, wallet.id, bill, "payout_failed");

    // #when
    await draft(new Date("2026-12-23T06:00:00Z"));

    // #then
    const runs = await runsOf(db, company);
    const december = await billsOfRun(db, company, runs[1]?.id ?? "");
    expect(
      december.map((row) => [row.payeeId, row.recurringItemId, row.dueOn]),
    ).toEqual([[payeeId, salaryId, "2026-12-28"]]);
  });
});

describe("pay days past a month's end", () => {
  it.each([
    {
      payDay: 31,
      nextDueOn: "2026-11-30",
      draftedAt: "2026-11-24T21:00:00Z",
      following: "2026-12-31",
    },
    {
      payDay: 30,
      nextDueOn: "2027-02-28",
      draftedAt: "2027-02-22T21:00:00Z",
      following: "2027-03-30",
    },
    {
      payDay: 29,
      nextDueOn: "2028-02-29",
      draftedAt: "2028-02-23T21:00:00Z",
      following: "2028-03-29",
    },
  ])(
    "pays the $payDay on $nextDueOn, drafted at $draftedAt",
    async ({ payDay, nextDueOn, draftedAt, following }) => {
      // #given
      const { salaryId } = await salaryFor({
        scheduleDay: payDay,
        nextDueOn,
      });
      const justBefore = new Date(new Date(draftedAt).getTime() - 1000);

      // #when
      await draft(justBefore);
      const before = (await runsOf(db, company)).length;
      await draft(new Date(draftedAt));

      // #then
      expect({
        before,
        runs: (await runsOf(db, company)).map((run) => run.payDate),
        following: (await readSalary(db, company, salaryId)).nextDueOn,
      }).toEqual({ before: 0, runs: [nextDueOn], following });
    },
  );
});

describe("payroll dates and cap", () => {
  it.each([
    ["2026-11-28", "2026-11-23"],
    ["2026-12-03", "2026-11-28"],
    ["2028-03-01", "2028-02-25"],
    ["2027-03-02", "2027-02-25"],
  ])("drafts pay date %s on %s", (payDate, draftDate) => {
    expect(draftDateFor(payDate)).toBe(draftDate);
  });

  it.each([
    [5_000_000n, 20, 6_000_000n],
    [3n, 20, 3n],
    [8_000_050n, 15, 9_200_057n],
    [1_000_000n, 0, 1_000_000n],
  ])("caps %s cents with a %s%% margin at %s", (salaries, margin, cap) => {
    expect(payrollCapKes(salaries, margin)).toBe(cap);
  });

  it.each([
    {
      case: "a later day, same month as the next undrafted pay date",
      nextDueOn: "2026-12-28",
      payDay: 30,
      today: "2026-11-26",
      expected: "2026-12-30",
    },
    {
      case: "an earlier day that's still to come",
      nextDueOn: "2026-11-28",
      payDay: 25,
      today: "2026-11-20",
      expected: "2026-11-25",
    },
    {
      case: "an earlier day that has passed",
      nextDueOn: "2026-11-28",
      payDay: 15,
      today: "2026-11-20",
      expected: null,
    },
    {
      case: "a day past a short month's end",
      nextDueOn: "2027-02-28",
      payDay: 31,
      today: "2027-02-01",
      expected: "2027-02-28",
    },
  ])("moves the pay day to $case", ({ nextDueOn, payDay, today, expected }) => {
    expect(
      nextPayDateOnNewDay(
        { startsOn: "2026-01-01", endsOn: null, nextDueOn },
        payDay,
        today,
      ),
    ).toBe(expected);
  });
});
