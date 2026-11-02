import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  BillStatus,
  PayeeKind,
  PayeeMethod,
  PayrollPaymentKind,
  PayrollRunStatus,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow, PayrollRun } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import {
  bills,
  categories,
  memberships,
  payees,
  payrollRuns,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate, scheduledStatus } from "../bills/status.js";
import { refreshRunTotal } from "./drafts.js";
import { checkCategory, findSalaryPayee } from "./salaries.js";

/**
 * Payroll runs (spec §6.21), for admins only (spec §4), down to row-level
 * security. While a run is a draft, an admin can, for that run only and
 * each with a reason, audited:
 *
 * - change one person's pay, e.g. a bonus or unpaid leave
 * - leave someone out (their bill is cancelled with the reason)
 * - add a one-off payment to someone, as an extra bill in the run
 *
 * Each change recomputes the run's total. Once the run isn't a draft,
 * nothing changes here. The cap stays as drafted: adjustments and one-offs
 * must fit under it when the run is paid (T39).
 */

export interface PayrollPayeeView {
  readonly id: string;
  readonly name: string;
  readonly kind: PayeeKind;
  readonly method: PayeeMethod | null;
  readonly archived: boolean;
  readonly payoutPhoneConfirmed: boolean | null;
}

export interface PayrollPaymentView {
  readonly billId: string;
  readonly kind: PayrollPaymentKind;
  readonly salaryId: string | null;
  readonly payee: PayrollPayeeView;
  readonly category: { readonly id: string; readonly name: string };
  readonly amountKes: bigint;
  readonly status: BillStatus;
  readonly adjustmentReason: string | null;
  readonly note: string | null;
  readonly leftOut: { readonly reason: string; readonly at: Date } | null;
  readonly paidOn: string | null;
}

export interface PayrollRunView {
  readonly id: string;
  readonly payDate: string;
  readonly status: PayrollRunStatus;
  readonly totalKes: bigint;
  readonly salariesKes: bigint;
  readonly capKes: bigint;
  readonly people: number;
  readonly leftOut: number;
  readonly createdAt: Date;
  readonly approvedAt: Date | null;
}

export interface PayrollRunDetailView extends PayrollRunView {
  readonly payments: readonly PayrollPaymentView[];
}

type RunDeps = DatabaseService | AuditLog;
type RunError = BadRequest | Conflict | NotFound | DatabaseError;

const runNotFound = new NotFound({
  message: "That payroll run wasn't found.",
});
const paymentNotFound = new NotFound({
  message: "That payment isn't in this payroll run.",
});
const notADraft = new Conflict({
  message: "This payroll run has been approved, so it can't change.",
});
const alreadyLeftOut = new Conflict({
  message: "They're already left out of this run.",
});

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

// ── Reading ──────────────────────────────────────────────────────────────

// Raw SQL: in a single-table select, drizzle leaves columns unqualified,
// which inside these subqueries would resolve to the bill's own `id`.
const runColumns = {
  run: payrollRuns,
  people: sql<number>`(SELECT count(*)::int FROM bills b WHERE b.payroll_run_id = payroll_runs.id AND b.status <> 'cancelled')`,
  leftOut: sql<number>`(SELECT count(*)::int FROM bills b WHERE b.payroll_run_id = payroll_runs.id AND b.status = 'cancelled')`,
};

function toRunView(row: {
  readonly run: PayrollRun;
  readonly people: number;
  readonly leftOut: number;
}): PayrollRunView {
  const { run } = row;
  return {
    id: run.id,
    payDate: run.payDate,
    status: run.status,
    totalKes: run.totalKes,
    salariesKes: run.salariesKes,
    capKes: run.capKes,
    people: row.people,
    leftOut: row.leftOut,
    createdAt: run.createdAt,
    approvedAt: run.approvedAt,
  };
}

/** Latest pay date first. */
export function listPayrollRuns(
  tenant: Tenant,
  limit: number,
): Effect.Effect<PayrollRunView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select(runColumns)
        .from(payrollRuns)
        .where(eq(payrollRuns.organizationId, tenant.organizationId))
        .orderBy(desc(payrollRuns.payDate))
        .limit(limit),
    ).pipe(Effect.map((rows) => rows.map(toRunView))),
  );
}

const paymentColumns = {
  bill: bills,
  payeeName: payees.name,
  payeeKind: payees.kind,
  payeeMethod: payees.method,
  payeeArchived: payees.archived,
  payoutPhoneConfirmed: sql<
    boolean | null
  >`CASE WHEN ${payees.membershipId} IS NULL THEN NULL ELSE ${users.phone} IS NOT NULL END`,
  categoryName: categories.name,
};

interface SelectedPayment {
  readonly bill: BillRow;
  readonly payeeName: string;
  readonly payeeKind: PayeeKind;
  readonly payeeMethod: PayeeMethod | null;
  readonly payeeArchived: boolean;
  readonly payoutPhoneConfirmed: boolean | null;
  readonly categoryName: string;
}

function toPaymentView(row: SelectedPayment): PayrollPaymentView {
  const { bill } = row;
  if (bill.amountKes === null) {
    throw new Error(`payroll bill ${bill.id} has no amount`);
  }
  return {
    billId: bill.id,
    kind: bill.recurringItemId === null ? "one_off" : "salary",
    salaryId: bill.recurringItemId,
    payee: {
      id: bill.payeeId,
      name: row.payeeName,
      kind: row.payeeKind,
      method: row.payeeMethod,
      archived: row.payeeArchived,
      payoutPhoneConfirmed: row.payoutPhoneConfirmed,
    },
    category: { id: bill.categoryId, name: row.categoryName },
    amountKes: bill.amountKes,
    status: bill.status,
    adjustmentReason: bill.adjustmentReason,
    note: bill.recurringItemId === null ? bill.notes : null,
    leftOut:
      bill.status === "cancelled" &&
      bill.cancelledReason !== null &&
      bill.cancelledAt !== null
        ? { reason: bill.cancelledReason, at: bill.cancelledAt }
        : null,
    paidOn: bill.paidOn,
  };
}

function readRun(
  tx: Transaction,
  organizationId: string,
  runId: string,
): Effect.Effect<PayrollRunDetailView, NotFound | DatabaseError> {
  return Effect.gen(function* () {
    const [run] = yield* query(() =>
      tx
        .select(runColumns)
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.organizationId, organizationId),
            eq(payrollRuns.id, runId),
          ),
        )
        .limit(1),
    );
    if (!run) return yield* Effect.fail(runNotFound);
    const payments = yield* query(() =>
      tx
        .select(paymentColumns)
        .from(bills)
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .innerJoin(categories, eq(categories.id, bills.categoryId))
        .leftJoin(memberships, eq(memberships.id, payees.membershipId))
        .leftJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.payrollRunId, runId),
          ),
        )
        .orderBy(
          sql`${bills.status} = 'cancelled'`,
          sql`lower(${payees.name}) COLLATE "C"`,
          sql`${bills.recurringItemId} IS NULL`,
          asc(bills.createdAt),
          asc(bills.id),
        ),
    );
    return { ...toRunView(run), payments: payments.map(toPaymentView) };
  });
}

/** The run with everyone in it: the people left out last. */
export function getPayrollRun(
  tenant: Tenant,
  runId: string,
): Effect.Effect<
  PayrollRunDetailView,
  NotFound | DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) => readRun(tx, tenant.organizationId, runId));
}

// ── Draft changes ────────────────────────────────────────────────────────

/** The run, locked for the rest of the transaction, while it's still a draft. */
function lockDraftRun(
  tx: Transaction,
  organizationId: string,
  runId: string,
): Effect.Effect<PayrollRun, NotFound | Conflict | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.organizationId, organizationId),
          eq(payrollRuns.id, runId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([run]): Effect.Effect<PayrollRun, NotFound | Conflict> => {
      if (!run) return Effect.fail(runNotFound);
      return run.status === "draft"
        ? Effect.succeed(run)
        : Effect.fail(notADraft);
    }),
  );
}

/** A payment in the run that isn't left out, locked after the run. */
function lockRunPayment(
  tx: Transaction,
  organizationId: string,
  runId: string,
  billId: string,
): Effect.Effect<BillRow & { readonly amountKes: bigint }, RunError> {
  return query(() =>
    tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, organizationId),
          eq(bills.payrollRunId, runId),
          eq(bills.id, billId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(
      ([bill]): Effect.Effect<
        BillRow & { readonly amountKes: bigint },
        NotFound | Conflict
      > => {
        if (!bill) return Effect.fail(paymentNotFound);
        if (bill.status === "cancelled") return Effect.fail(alreadyLeftOut);
        const { amountKes } = bill;
        return amountKes === null
          ? Effect.dieMessage(`payroll bill ${bill.id} has no amount`)
          : Effect.succeed({ ...bill, amountKes });
      },
    ),
  );
}

interface DraftChange {
  readonly action: string;
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * Locks the draft, makes `change`, refreshes the total, audits it and
 * returns the run as it now is, all in one transaction.
 */
function changeDraft(
  tenant: Tenant,
  runId: string,
  change: (
    tx: Transaction,
    run: PayrollRun,
  ) => Effect.Effect<DraftChange, RunError, AuditLog>,
): Effect.Effect<PayrollRunDetailView, RunError, RunDeps> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const run = yield* lockDraftRun(tx, organizationId, runId);
      const { action, before, after } = yield* change(tx, run);
      const totalKes = yield* refreshRunTotal(tx, run.id);
      yield* audit.record(tx, {
        actor: userActor(tenant),
        organizationId,
        action,
        entity: { type: "payroll_run", id: run.id },
        before: { ...before, totalKes: run.totalKes },
        after: { ...after, totalKes },
      });
      return yield* readRun(tx, organizationId, run.id);
    }),
  );
}

/** Changes one person's pay for this run only. */
export function adjustPayrollPayment(
  tenant: Tenant,
  runId: string,
  billId: string,
  fields: { readonly amountKes: bigint; readonly reason: string },
): Effect.Effect<PayrollRunDetailView, RunError, RunDeps> {
  return changeDraft(tenant, runId, (tx, run) =>
    Effect.gen(function* () {
      const bill = yield* lockRunPayment(
        tx,
        tenant.organizationId,
        run.id,
        billId,
      );
      if (bill.amountKes === fields.amountKes) {
        return yield* Effect.fail(
          new BadRequest({ message: "That's already their pay in this run." }),
        );
      }
      yield* query(() =>
        tx
          .update(bills)
          .set({
            amountKes: fields.amountKes,
            adjustmentReason: fields.reason,
          })
          .where(eq(bills.id, bill.id)),
      );
      return {
        action: "payroll_run.payment_adjusted",
        before: { billId: bill.id, amountKes: bill.amountKes },
        after: {
          billId: bill.id,
          payeeId: bill.payeeId,
          amountKes: fields.amountKes,
          reason: fields.reason,
        },
      };
    }),
  );
}

/** Leaves someone out of this run: their bill is cancelled with the reason. */
export function leaveOutOfPayroll(
  tenant: Tenant,
  runId: string,
  billId: string,
  reason: string,
): Effect.Effect<PayrollRunDetailView, RunError, RunDeps> {
  return changeDraft(tenant, runId, (tx, run) =>
    Effect.gen(function* () {
      const bill = yield* lockRunPayment(
        tx,
        tenant.organizationId,
        run.id,
        billId,
      );
      yield* query(() =>
        tx
          .update(bills)
          .set({
            status: "cancelled",
            cancelledReason: reason,
            cancelledBy: tenant.userId,
            cancelledAt: sql`now()`,
          })
          .where(eq(bills.id, bill.id)),
      );
      return {
        action: "payroll_run.payment_left_out",
        before: { billId: bill.id, status: bill.status },
        after: {
          billId: bill.id,
          payeeId: bill.payeeId,
          status: "cancelled",
          amountKes: bill.amountKes,
          reason,
        },
      };
    }),
  );
}

/**
 * The category a one-off takes when none is picked: the person's salary
 * in this run, or their current salary.
 */
function salaryCategoryOf(
  tx: Transaction,
  organizationId: string,
  runId: string,
  payeeId: string,
): Effect.Effect<string | null, DatabaseError> {
  return Effect.gen(function* () {
    const [inRun] = yield* query(() =>
      tx
        .select({ categoryId: bills.categoryId })
        .from(bills)
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.payrollRunId, runId),
            eq(bills.payeeId, payeeId),
            sql`${bills.recurringItemId} IS NOT NULL`,
          ),
        )
        .limit(1),
    );
    if (inRun) return inRun.categoryId;
    const [salary] = yield* query(() =>
      tx
        .select({ categoryId: recurringItems.categoryId })
        .from(recurringItems)
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.payeeId, payeeId),
            eq(recurringItems.overviewHeading, "salaries"),
            sql`${recurringItems.nextDueOn} IS NOT NULL`,
          ),
        )
        .limit(1),
    );
    return salary?.categoryId ?? null;
  });
}

/** Adds a one-off payment to someone in this run, e.g. a bonus. */
export function addPayrollOneOff(
  tenant: Tenant,
  runId: string,
  fields: {
    readonly payeeId: string;
    readonly amountKes: bigint;
    readonly reason: string;
    readonly categoryId?: string | undefined;
  },
  now: Date = new Date(),
): Effect.Effect<PayrollRunDetailView, RunError, RunDeps> {
  const { organizationId } = tenant;
  return changeDraft(tenant, runId, (tx, run) =>
    Effect.gen(function* () {
      yield* findSalaryPayee(tx, organizationId, fields.payeeId);
      const categoryId =
        fields.categoryId ??
        (yield* salaryCategoryOf(tx, organizationId, run.id, fields.payeeId));
      if (categoryId === null) {
        return yield* Effect.fail(
          new BadRequest({ message: "Pick a category for this payment." }),
        );
      }
      yield* checkCategory(tx, organizationId, categoryId);
      const values = {
        payeeId: fields.payeeId,
        payrollRunId: run.id,
        overviewHeading: "salaries" as const,
        categoryId,
        variable: false,
        amountKes: fields.amountKes,
        notes: fields.reason,
        dueOn: run.payDate,
        status: scheduledStatus(run.payDate, nairobiDate(now)),
      };
      const [created] = yield* query(() =>
        tx
          .insert(bills)
          .values({ organizationId, ...values })
          .returning({ id: bills.id }),
      );
      if (!created) {
        return yield* Effect.dieMessage("one-off bill insert wrote no row");
      }
      return {
        action: "payroll_run.one_off_added",
        after: {
          billId: created.id,
          payeeId: fields.payeeId,
          amountKes: fields.amountKes,
          reason: fields.reason,
          categoryId,
        },
      };
    }),
  );
}
