import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { AccountingSyncSubjectType } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  accountingConnections,
  accountingSyncs,
  bills,
  expenses,
  payrollRuns,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * Queues paid spending for Zoho Books (spec §6.17) inside the transaction
 * that makes it final, so an item is queued exactly then and never
 * otherwise: a claim, bill or payroll run once paid, petty cash and company
 * spending once recorded. The station's `zoho-sync` job does the Zoho calls
 * later.
 *
 * Float issues and top-ups move money between the company's own accounts
 * and imported history is already in the books, so neither is queued.
 *
 * This module only writes the queue: it must stay free of Zoho, storage and
 * payout code, since the payout engine's hooks import it.
 */

/** The audit log's entity type for a sync. */
export const ACCOUNTING_SYNC = "accounting_sync";

export interface AccountingSubject {
  readonly organizationId: string;
  readonly type: AccountingSyncSubjectType;
  readonly id: string;
}

/**
 * Queues one item, at most once. Only a company with a Zoho connection that
 * isn't disconnected queues anything: a pending or `needs_reconnect`
 * connection keeps what's queued until it's active, but a company that never
 * connected, or disconnected, doesn't build up a backlog that a later
 * connection would push.
 */
export function enqueueAccountingSync(
  tx: Transaction,
  subject: AccountingSubject,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [connection] = yield* query(() =>
      tx
        .select({ id: accountingConnections.id })
        .from(accountingConnections)
        .where(
          and(
            eq(accountingConnections.organizationId, subject.organizationId),
            ne(accountingConnections.status, "disconnected"),
          ),
        )
        .limit(1),
    );
    if (!connection) return;
    yield* query(() =>
      tx
        .insert(accountingSyncs)
        .values({
          organizationId: subject.organizationId,
          subjectType: subject.type,
          subjectId: subject.id,
        })
        .onConflictDoNothing(),
    );
  });
}

/**
 * A claim that reached `paid` through its payout. Imported history is
 * `paid_outside` and already in the books, so it never gets here.
 */
export function enqueuePaidClaim(
  tx: Transaction,
  organizationId: string,
  claimId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [claim] = yield* query(() =>
      tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(
          and(
            eq(expenses.id, claimId),
            eq(expenses.organizationId, organizationId),
            eq(expenses.kind, "claim"),
            eq(expenses.status, "paid"),
            eq(expenses.source, "app"),
          ),
        ),
    );
    if (!claim) return;
    yield* enqueueAccountingSync(tx, {
      organizationId,
      type: "expense",
      id: claim.id,
    });
  });
}

/**
 * Petty cash or company spending, just recorded, or a Card expense once it
 * has its receipt or an admin's reason (the caller decides that). Company
 * spending that a bill marked paid outside recorded is that bill's: the bill
 * is queued instead, so the payment reaches Zoho once.
 */
export function enqueueRecordedSpending(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [spending] = yield* query(() =>
      tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.organizationId, organizationId),
            inArray(expenses.kind, ["float", "company", "card"]),
            eq(expenses.status, "recorded"),
            eq(expenses.source, "app"),
            isNull(expenses.billId),
          ),
        ),
    );
    if (!spending) return;
    yield* enqueueAccountingSync(tx, {
      organizationId,
      type: "expense",
      id: spending.id,
    });
  });
}

/**
 * A bill paid through Expendi or marked paid outside. Salary bills reach
 * Zoho as part of their payroll run's one expense.
 */
export function enqueuePaidBill(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [bill] = yield* query(() =>
      tx
        .select({ id: bills.id })
        .from(bills)
        .where(
          and(
            eq(bills.id, billId),
            eq(bills.organizationId, organizationId),
            inArray(bills.status, ["paid", "paid_outside"]),
            isNull(bills.payrollRunId),
          ),
        ),
    );
    if (!bill) return;
    yield* enqueueAccountingSync(tx, {
      organizationId,
      type: "bill",
      id: bill.id,
    });
  });
}

/** A payroll run once everyone in it is paid: one Zoho expense for its total. */
export function enqueuePaidPayrollRun(
  tx: Transaction,
  organizationId: string,
  runId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [run] = yield* query(() =>
      tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.id, runId),
            eq(payrollRuns.organizationId, organizationId),
            eq(payrollRuns.status, "paid"),
            gt(payrollRuns.totalKes, 0n),
          ),
        ),
    );
    if (!run) return;
    yield* enqueueAccountingSync(tx, {
      organizationId,
      type: "payroll_run",
      id: run.id,
    });
  });
}
