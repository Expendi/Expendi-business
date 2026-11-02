import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { PAYROLL_DRAFT_LEAD_DAYS } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { PayrollRun, RecurringItemRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import {
  bills,
  organizations,
  payees,
  payrollRuns,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate, scheduledStatus } from "../bills/status.js";
import { dueAfter } from "../recurring/schedule.js";
import { payrollCapKes } from "./cap.js";

/**
 * Drafting payroll runs (spec §6.21): 5 Nairobi days before a pay date,
 * everyone whose salary is due that day goes into the company's run for
 * that date, one bill each, at their net pay.
 *
 * Exactly once:
 *
 * - A salary's `next_due_on` is its next pay date not yet in a run. It is
 *   moved on to the following pay date (clamped to short months, from
 *   `recurring/schedule.ts`) in the transaction that drafts it, with the
 *   salary locked, so a second attempt finds nothing due.
 * - The run is the company's only one for that date
 *   (`payroll_runs_organization_pay_date_unique`): a salary drafted later,
 *   e.g. set up two days before pay day, joins the draft already there.
 * - A salary has one bill per run (`bills_payroll_run_salary_unique`).
 *
 * The cap is fixed here: the net pay of the salaries drafted in, plus the
 * company's margin (`payroll_runs.salaries_kes`, `cap_kes`).
 */

const PAYROLL_DRAFTS: AuditActor = { type: "system", id: "payroll-drafts" };

export type PayrollDraftOutcome =
  | {
      readonly kind: "drafted";
      readonly runId: string;
      /** A new run, rather than salaries added to a draft already there. */
      readonly created: boolean;
      readonly payments: number;
    }
  | { readonly kind: "nothing_due" }
  /**
   * The run for that date was already approved: these salaries skip that
   * pay date (audited), and the admin pays them some other way.
   */
  | {
      readonly kind: "run_closed";
      readonly runId: string;
      readonly skipped: number;
    };

type DueSalary = RecurringItemRow & { readonly amountKes: bigint };

/** Active salaries due on `payDate` and not yet drafted, locked. */
function lockDueSalaries(
  tx: Transaction,
  organizationId: string,
  payDate: string,
): Effect.Effect<DueSalary[], DatabaseError> {
  return query(() =>
    tx
      .select({ item: recurringItems })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.overviewHeading, "salaries"),
          eq(recurringItems.active, true),
          eq(recurringItems.nextDueOn, payDate),
          eq(payees.archived, false),
        ),
      )
      .orderBy(asc(recurringItems.id))
      .for("update", { of: recurringItems }),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, ({ item }) =>
        item.amountKes === null
          ? Effect.dieMessage(`salary ${item.id} has no amount`)
          : Effect.succeed({ ...item, amountKes: item.amountKes }),
      ),
    ),
  );
}

/** The company's run for `payDate`, created as a draft if there's none; locked either way. */
function findOrCreateRun(
  tx: Transaction,
  organizationId: string,
  payDate: string,
  salariesKes: bigint,
  capKes: bigint,
): Effect.Effect<
  { readonly run: PayrollRun; readonly created: boolean },
  DatabaseError
> {
  return Effect.gen(function* () {
    const [created] = yield* query(() =>
      tx
        .insert(payrollRuns)
        .values({
          organizationId,
          payDate,
          status: "draft",
          totalKes: 0n,
          salariesKes,
          capKes,
        })
        .onConflictDoNothing({
          target: [payrollRuns.organizationId, payrollRuns.payDate],
        })
        .returning(),
    );
    if (created) return { run: created, created: true };
    const [existing] = yield* query(() =>
      tx
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.organizationId, organizationId),
            eq(payrollRuns.payDate, payDate),
          ),
        )
        .for("update"),
    );
    if (!existing) {
      return yield* Effect.dieMessage(
        `payroll run for ${payDate} clashed but wasn't found`,
      );
    }
    return { run: existing, created: false };
  });
}

/**
 * Sets the run's total from its bills: everyone not left out. Call after
 * any change to the run's bills, in the same transaction.
 */
export function refreshRunTotal(
  tx: Transaction,
  runId: string,
): Effect.Effect<bigint, DatabaseError> {
  return query(() =>
    tx
      .update(payrollRuns)
      .set({
        totalKes: sql`(SELECT coalesce(sum(${bills.amountKes}), 0) FROM ${bills} WHERE ${bills.payrollRunId} = ${runId} AND ${bills.status} <> 'cancelled')`,
      })
      .where(eq(payrollRuns.id, runId))
      .returning({ totalKes: payrollRuns.totalKes }),
  ).pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed(row.totalKes)
        : Effect.dieMessage(`payroll run ${runId} vanished`),
    ),
  );
}

function marginOf(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<number, DatabaseError> {
  return query(() =>
    tx
      .select({ marginPct: organizations.payrollCapMarginPct })
      .from(organizations)
      .where(eq(organizations.id, organizationId)),
  ).pipe(
    Effect.flatMap(([company]) =>
      company
        ? Effect.succeed(company.marginPct)
        : Effect.dieMessage(`company ${organizationId} not found`),
    ),
  );
}

function moveOnFrom(
  tx: Transaction,
  salary: DueSalary,
  payDate: string,
): Effect.Effect<string | null, DatabaseError> {
  const following = dueAfter(salary, payDate);
  return query(() =>
    tx
      .update(recurringItems)
      .set({ nextDueOn: following })
      .where(eq(recurringItems.id, salary.id)),
  ).pipe(Effect.as(following));
}

const sumKes = (amounts: readonly bigint[]): bigint =>
  amounts.reduce((sum, amount) => sum + amount, 0n);

/**
 * Drafts the company's run for `payDate` with every salary due that day
 * and not yet drafted, or adds them to the draft already there. `today`
 * is the Nairobi date, which sets each bill's dated status. Runs inside
 * the caller's transaction and company scope, which must carry the admin
 * role; audited as the system.
 */
export function draftPayrollRun(
  tx: Transaction,
  organizationId: string,
  payDate: string,
  today: string,
): Effect.Effect<PayrollDraftOutcome, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const salaries = yield* lockDueSalaries(tx, organizationId, payDate);
    if (salaries.length === 0) return { kind: "nothing_due" };

    const marginPct = yield* marginOf(tx, organizationId);
    const dueKes = sumKes(salaries.map((salary) => salary.amountKes));
    const { run, created } = yield* findOrCreateRun(
      tx,
      organizationId,
      payDate,
      dueKes,
      payrollCapKes(dueKes, marginPct),
    );

    if (run.status !== "draft") {
      for (const salary of salaries) {
        const nextPayDate = yield* moveOnFrom(tx, salary, payDate);
        yield* audit.record(tx, {
          actor: PAYROLL_DRAFTS,
          organizationId,
          action: "salary.pay_date_skipped",
          entity: { type: "recurring_item", id: salary.id },
          before: { nextDueOn: payDate },
          after: {
            nextDueOn: nextPayDate,
            payrollRunId: run.id,
            reason: "The payroll run for this date was already approved.",
          },
        });
      }
      return { kind: "run_closed", runId: run.id, skipped: salaries.length };
    }

    const status = scheduledStatus(payDate, today);
    const inserted = yield* query(() =>
      tx
        .insert(bills)
        .values(
          salaries.map((salary) => ({
            organizationId,
            payeeId: salary.payeeId,
            recurringItemId: salary.id,
            payrollRunId: run.id,
            overviewHeading: "salaries" as const,
            categoryId: salary.categoryId,
            variable: false,
            amountKes: salary.amountKes,
            dueOn: payDate,
            status,
          })),
        )
        .onConflictDoNothing()
        .returning({
          billId: bills.id,
          payeeId: bills.payeeId,
          salaryId: bills.recurringItemId,
          amountKes: bills.amountKes,
        }),
    );
    for (const salary of salaries) {
      yield* moveOnFrom(tx, salary, payDate);
    }

    const insertedSalaryIds = new Set(inserted.map((bill) => bill.salaryId));
    const addedKes = sumKes(
      salaries
        .filter((salary) => insertedSalaryIds.has(salary.id))
        .map((salary) => salary.amountKes),
    );
    const salariesKes = created ? run.salariesKes : run.salariesKes + addedKes;
    const capKes = created ? run.capKes : payrollCapKes(salariesKes, marginPct);
    if (!created) {
      yield* query(() =>
        tx
          .update(payrollRuns)
          .set({ salariesKes, capKes })
          .where(eq(payrollRuns.id, run.id)),
      );
    }
    const totalKes = yield* refreshRunTotal(tx, run.id);

    yield* audit.record(tx, {
      actor: PAYROLL_DRAFTS,
      organizationId,
      action: created ? "payroll_run.drafted" : "payroll_run.salaries_added",
      entity: { type: "payroll_run", id: run.id },
      before: created
        ? undefined
        : {
            salariesKes: run.salariesKes,
            capKes: run.capKes,
            totalKes: run.totalKes,
          },
      after: {
        payDate,
        marginPct,
        salariesKes,
        capKes,
        totalKes,
        payments: inserted,
      },
    });
    return {
      kind: "drafted",
      runId: run.id,
      created,
      payments: inserted.length,
    };
  });
}

const admin = (organizationId: string) =>
  ({ organizationId, role: "admin" }) as const;

/**
 * Drafts every run the company has due by `now`: each pay date at most 5
 * Nairobi days away with a salary not yet drafted, each in its own
 * transaction. Used after a salary change so its run appears at once; the
 * payroll-drafts job does the same for every company.
 */
export function draftDuePayroll(
  organizationId: string,
  now: Date,
): Effect.Effect<
  PayrollDraftOutcome[],
  DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const today = nairobiDate(now);
    const due = yield* withScope(admin(organizationId), (tx) =>
      query(() =>
        tx
          .selectDistinct({ payDate: recurringItems.nextDueOn })
          .from(recurringItems)
          .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
          .where(
            and(
              eq(recurringItems.organizationId, organizationId),
              eq(recurringItems.overviewHeading, "salaries"),
              eq(recurringItems.active, true),
              eq(payees.archived, false),
              isNotNull(recurringItems.nextDueOn),
              sql`${recurringItems.nextDueOn} <= ${today}::date + ${PAYROLL_DRAFT_LEAD_DAYS}::integer`,
            ),
          )
          .orderBy(asc(recurringItems.nextDueOn)),
      ),
    );
    return yield* Effect.forEach(due, ({ payDate }) =>
      payDate === null
        ? Effect.succeed<PayrollDraftOutcome>({ kind: "nothing_due" })
        : withScope(admin(organizationId), (tx) =>
            draftPayrollRun(tx, organizationId, payDate, today),
          ),
    );
  });
}

export interface PayrollDraftsRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  /**
   * Runs drafted by this run, for the admins' notification (T43):
   * "payroll for <payDate> is ready to review".
   */
  readonly drafted: readonly {
    readonly organizationId: string;
    readonly runId: string;
    readonly payDate: string;
  }[];
  /** Drafts already there that late salaries joined. */
  readonly updated: number;
  /** Pay dates whose run was already approved. */
  readonly closed: number;
  readonly failed: number;
}

interface DuePayDate extends Record<string, unknown> {
  readonly organization_id: string;
  readonly pay_date: string;
}

/**
 * The payroll-drafts job: every company's runs due by `now`, across
 * companies. Each pay date is its own transaction in its company's scope,
 * so one failure doesn't stop the rest. Safe to run any number of times,
 * or in two places at once. `now` is read when it runs.
 */
export function draftDuePayrollRuns(
  now?: Date,
  maxRows = 200,
): Effect.Effect<PayrollDraftsRun, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    const today = nairobiDate(now ?? new Date());
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<DuePayDate>(
          sql`SELECT organization_id, pay_date::text AS pay_date FROM salary_pay_dates_to_draft(${today}::date, ${PAYROLL_DRAFT_LEAD_DAYS}::integer, ${maxRows}::integer)`,
        ),
      ),
    );

    const drafted: PayrollDraftsRun["drafted"][number][] = [];
    let updated = 0;
    let closed = 0;
    let failed = 0;
    for (const due of rows) {
      const exit = yield* Effect.exit(
        withScope(admin(due.organization_id), (tx) =>
          draftPayrollRun(tx, due.organization_id, due.pay_date, today),
        ),
      );
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[payroll-drafts] company ${due.organization_id}, pay date ${due.pay_date}: drafting failed`,
          Cause.pretty(exit.cause),
        );
        continue;
      }
      const outcome = exit.value;
      if (outcome.kind === "drafted" && outcome.created) {
        drafted.push({
          organizationId: due.organization_id,
          runId: outcome.runId,
          payDate: due.pay_date,
        });
      } else if (outcome.kind === "drafted") {
        updated += 1;
      } else if (outcome.kind === "run_closed") {
        closed += 1;
      }
    }
    return { today, drafted, updated, closed, failed };
  });
}
