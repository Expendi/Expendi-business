import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type {
  BillRow,
  NewRecurringItem,
  PayrollRun,
  RecurringItemRow,
} from "../../db/schema/index.js";
import type { TestCompany, TestUser } from "./db.js";
import {
  bills,
  payouts,
  payrollRuns,
  recurringItems,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertPayee } from "./bills.js";
import { addMember, createUser } from "./db.js";
import { randomKenyanMobile } from "./payees.js";

const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

export interface PayrollPerson {
  readonly user: TestUser;
  readonly membershipId: string;
  readonly payeeId: string;
}

/** An active employee who is a payee, paid to the M-Pesa number they confirm. */
export async function addEmployeePayee(
  db: Database,
  company: TestCompany,
  name = `Employee ${randomUUID().slice(0, 8)}`,
): Promise<PayrollPerson> {
  const user = await createUser(db);
  const membershipId = await addMember(db, company, user);
  const payeeId = await insertPayee(db, company, {
    kind: "employee",
    name,
    membershipId,
    method: "mpesa_phone",
    accountName: name,
    detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { user, membershipId, payeeId };
}

/** Personnel without an app login, paid to their own M-Pesa number. */
export function insertPersonnelPayee(
  db: Database,
  company: TestCompany,
  name = `Casual ${randomUUID().slice(0, 8)}`,
  phone = randomKenyanMobile(),
): Promise<string> {
  return insertPayee(db, company, {
    kind: "personnel",
    name,
    method: "mpesa_phone",
    phone,
    accountName: name,
    detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
  });
}

/**
 * A salary written straight to the table, as if set up earlier: by default
 * KES 50,000 a month on the 28th, next paid 28 Nov 2026 and not yet drafted.
 */
export async function insertSalary(
  db: Database,
  company: TestCompany,
  values: Partial<NewRecurringItem> &
    Pick<NewRecurringItem, "payeeId" | "categoryId">,
): Promise<string> {
  const [salary] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(recurringItems)
      .values({
        organizationId: company.organizationId,
        overviewHeading: "salaries",
        amountKes: 5_000_000n,
        schedule: "monthly",
        scheduleDay: 28,
        startsOn: "2026-01-01",
        nextDueOn: "2026-11-28",
        ...values,
      })
      .returning({ id: recurringItems.id }),
  );
  if (!salary) throw new Error("salary insert returned no row");
  return salary.id;
}

export async function readSalary(
  db: Database,
  company: TestCompany,
  salaryId: string,
): Promise<RecurringItemRow> {
  const [salary] = await runInScope(db, asAdmin(company), (tx) =>
    tx.select().from(recurringItems).where(eq(recurringItems.id, salaryId)),
  );
  if (!salary) throw new Error(`salary ${salaryId} not found`);
  return salary;
}

/** The company's payroll runs, by pay date. */
export function runsOf(
  db: Database,
  company: TestCompany,
): Promise<PayrollRun[]> {
  return runInScope(db, asAdmin(company), (tx) =>
    tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.organizationId, company.organizationId))
      .orderBy(asc(payrollRuns.payDate)),
  );
}

export function billsOfRun(
  db: Database,
  company: TestCompany,
  runId: string,
): Promise<BillRow[]> {
  return runInScope(db, asAdmin(company), (tx) =>
    tx
      .select()
      .from(bills)
      .where(eq(bills.payrollRunId, runId))
      .orderBy(asc(bills.amountKes), asc(bills.id)),
  );
}

export async function setRunStatus(
  db: Database,
  company: TestCompany,
  runId: string,
  status: PayrollRun["status"],
): Promise<void> {
  await runInScope(db, asAdmin(company), (tx) =>
    tx.update(payrollRuns).set({ status }).where(eq(payrollRuns.id, runId)),
  );
}

/**
 * Settles a payroll bill as T39 would: a payout of the run for it, and the
 * bill `paid` (or `paying` / `payout_failed`) with that payout.
 */
export async function settlePayrollBill(
  db: Database,
  company: TestCompany,
  walletId: string,
  bill: Pick<BillRow, "id" | "payrollRunId" | "amountKes">,
  status: "paying" | "paid" | "payout_failed",
): Promise<string> {
  const amountKes = bill.amountKes ?? 100n;
  return runInScope(db, asAdmin(company), async (tx) => {
    const [payout] = await tx
      .insert(payouts)
      .values({
        organizationId: company.organizationId,
        walletId,
        subjectType: "bill",
        subjectId: bill.id,
        payrollRunId: bill.payrollRunId,
        idempotencyKey: `payroll:${bill.id}:${randomUUID()}`,
        method: "mpesa_phone",
        recipient: {
          method: "mpesa_phone",
          phone: randomKenyanMobile(),
          accountName: "Someone",
        },
        requestedKesCents: amountKes,
        amountKes,
        quotedRate: "129.00",
        quotedUsdc: 1_000_000n,
        maxDebitUsdc: 1_500_000n,
        status: "failed",
      })
      .returning({ id: payouts.id });
    if (!payout) throw new Error("payout insert returned no row");
    await tx
      .update(bills)
      .set({
        status,
        payoutId: payout.id,
        ...(status === "paid" && {
          paidOn: "2026-11-28",
          paidAt: new Date("2026-11-28T09:00:00Z"),
        }),
      })
      .where(eq(bills.id, bill.id));
    return payout.id;
  });
}
