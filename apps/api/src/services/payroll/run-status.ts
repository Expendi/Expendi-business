import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { PayrollRunStatus } from "@expendi-business/shared";

import type { PayrollRun } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import { bills, payrollRuns } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { enqueuePaidPayrollRun } from "../zoho/enqueue.js";

/**
 * Where an approved payroll run stands (spec §6.21), from its payments:
 * everyone not left out is one bill, each paid by its own payout(s).
 *
 * - `paying` while any payment is in flight
 * - then `partly_failed` if any failed (each is retried on its own), or
 *   `paid` once everyone is paid, which queues the run for Zoho Books (T44)
 *
 * A draft stays a draft until its approval moves a payment to `paying`.
 */

export interface PayrollProgress {
  readonly paid: number;
  readonly paying: number;
  readonly failed: number;
  /** Not paid, not being paid and not failed: only before approval. */
  readonly unpaid: number;
}

export function payrollProgress(
  tx: Transaction,
  runId: string,
): Effect.Effect<PayrollProgress, DatabaseError> {
  return query(() =>
    tx
      .select({
        paid: sql<number>`count(*) FILTER (WHERE ${bills.status} = 'paid')::int`,
        paying: sql<number>`count(*) FILTER (WHERE ${bills.status} = 'paying')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${bills.status} = 'payout_failed')::int`,
        unpaid: sql<number>`count(*) FILTER (WHERE ${bills.status} IN ('upcoming', 'due', 'overdue'))::int`,
      })
      .from(bills)
      .where(and(eq(bills.payrollRunId, runId), ne(bills.status, "cancelled"))),
  ).pipe(
    Effect.map(
      ([counts]) => counts ?? { paid: 0, paying: 0, failed: 0, unpaid: 0 },
    ),
  );
}

function statusFor(
  current: PayrollRunStatus,
  progress: PayrollProgress,
): PayrollRunStatus {
  if (progress.paying > 0) return "paying";
  if (current === "draft") return "draft";
  if (progress.failed > 0) return "partly_failed";
  return progress.unpaid === 0 ? "paid" : current;
}

/**
 * Moves the run on to where its payments now put it, audited. Call in the
 * transaction that changed a payment, holding the run's row lock. The
 * first approval also records who approved the run and when.
 */
export function refreshPayrollRunStatus(
  tx: Transaction,
  run: PayrollRun,
  actor: AuditActor,
  approval?: { readonly approvedBy: string; readonly approvedAt: Date },
): Effect.Effect<void, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const progress = yield* payrollProgress(tx, run.id);
    const status = statusFor(run.status, progress);
    if (status === run.status) return;
    const firstApproval =
      run.status === "draft" && approval !== undefined
        ? { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }
        : {};
    yield* query(() =>
      tx
        .update(payrollRuns)
        .set({ status, ...firstApproval })
        .where(eq(payrollRuns.id, run.id)),
    );
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor,
      organizationId: run.organizationId,
      action: "payroll_run.status_changed",
      entity: { type: "payroll_run", id: run.id },
      before: { status: run.status },
      after: { status, ...firstApproval, ...progress },
    });
    if (status === "paid") {
      yield* enqueuePaidPayrollRun(tx, run.organizationId, run.id);
    }
  });
}
