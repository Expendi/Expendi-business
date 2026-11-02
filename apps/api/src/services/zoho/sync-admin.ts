import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  AccountingSync,
  AccountingSyncsQuery,
  AccountingSyncsResponse,
  AccountingSyncSubject,
} from "@expendi-business/shared";
import { ACCOUNTING_SYNCS_PAGE_SIZE } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { AccountingSyncRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { StaffMember } from "../staff/staff-auth.js";
import { accountingSyncs, expenses } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { inCompany, staffActor } from "./connections.js";
import { ACCOUNTING_SYNC } from "./enqueue.js";

/**
 * A company's Zoho syncs as staff see and retry them (spec §6.15, §6.17).
 * Like the rest of `/internal/companies/:id/zoho`, each request runs in the
 * one company's scope. Retrying only puts the sync back in the queue: the
 * `zoho-sync` job makes the Zoho calls.
 *
 * Staff hold no role in the company, so row-level security shows them no
 * bills or payroll runs: those syncs are listed without what they post.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noSync = new NotFound({ message: "This company has no such Zoho sync" });

function subjectsOf(
  tx: Transaction,
  rows: readonly AccountingSyncRow[],
): Effect.Effect<ReadonlyMap<string, AccountingSyncSubject>, DatabaseError> {
  const expenseIds = rows
    .filter(({ subjectType }) => subjectType === "expense")
    .map(({ subjectId }) => subjectId);
  if (expenseIds.length === 0) return Effect.succeed(new Map());
  return query(() =>
    tx
      .select({
        id: expenses.id,
        kind: expenses.kind,
        merchant: expenses.merchant,
        spentOn: expenses.spentOn,
        amountKes: expenses.amountKes,
      })
      .from(expenses)
      .where(inArray(expenses.id, expenseIds)),
  ).pipe(
    Effect.map(
      (found) =>
        new Map(
          found.map(({ id, kind, merchant, spentOn, amountKes }) => [
            id,
            {
              expenseKind: kind,
              label: merchant,
              date: spentOn,
              amountKesCents: amountKes.toString(),
            },
          ]),
        ),
    ),
  );
}

function toSync(
  row: AccountingSyncRow,
  subjects: ReadonlyMap<string, AccountingSyncSubject>,
): AccountingSync {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subject: subjects.get(row.subjectId) ?? null,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    externalId: row.externalId,
    receiptAttached: row.receiptAttached,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `GET /internal/companies/:id/zoho/syncs`: counts, and the latest of one status. */
export function listAccountingSyncs(
  organizationId: string,
  { status }: AccountingSyncsQuery,
): Effect.Effect<
  AccountingSyncsResponse,
  NotFound | DatabaseError,
  DatabaseService
> {
  return inCompany(organizationId, (tx) =>
    Effect.gen(function* () {
      const counted = yield* query(() =>
        tx
          .select({
            status: accountingSyncs.status,
            count: sql<number>`count(*)::int`,
          })
          .from(accountingSyncs)
          .where(eq(accountingSyncs.organizationId, organizationId))
          .groupBy(accountingSyncs.status),
      );
      const rows = yield* query(() =>
        tx
          .select()
          .from(accountingSyncs)
          .where(
            and(
              eq(accountingSyncs.organizationId, organizationId),
              eq(accountingSyncs.status, status),
            ),
          )
          .orderBy(desc(accountingSyncs.updatedAt), desc(accountingSyncs.id))
          .limit(ACCOUNTING_SYNCS_PAGE_SIZE),
      );
      const subjects = yield* subjectsOf(tx, rows);
      const count = (wanted: AccountingSyncRow["status"]) =>
        counted.find((row) => row.status === wanted)?.count ?? 0;
      return {
        counts: {
          pending: count("pending"),
          synced: count("synced"),
          failed: count("failed"),
        },
        syncs: rows.map((row) => toSync(row, subjects)),
      };
    }),
  );
}

/**
 * `POST /internal/companies/:id/zoho/syncs/:syncId/requeue`: staff retry a
 * failed sync once its cause is fixed. It starts again with a full set of
 * tries; a Zoho ID it already has is kept, so it's never posted twice.
 */
export function requeueAccountingSync(
  staff: StaffMember,
  organizationId: string,
  syncId: string,
): Effect.Effect<
  AccountingSync,
  NotFound | Conflict | DatabaseError,
  DatabaseService | AuditLog
> {
  if (!UUID.test(syncId)) return Effect.fail(noSync);
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    return yield* inCompany(organizationId, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .select()
            .from(accountingSyncs)
            .where(
              and(
                eq(accountingSyncs.id, syncId),
                eq(accountingSyncs.organizationId, organizationId),
              ),
            )
            .for("update"),
        );
        if (!row) return yield* noSync;
        if (row.status !== "failed") {
          return yield* new Conflict({
            message:
              row.status === "synced"
                ? "This sync already reached Zoho."
                : "This sync is already waiting to run.",
          });
        }
        const [requeued] = yield* query(() =>
          tx
            .update(accountingSyncs)
            .set({ status: "pending", attempts: 0, nextAttemptAt: new Date() })
            .where(eq(accountingSyncs.id, row.id))
            .returning(),
        );
        if (!requeued) return yield* noSync;
        yield* audit.record(tx, {
          actor: staffActor(staff),
          organizationId,
          action: "accounting_sync.requeued",
          entity: { type: ACCOUNTING_SYNC, id: row.id },
          before: {
            status: row.status,
            attempts: row.attempts,
            lastError: row.lastError,
          },
          after: { status: "pending", attempts: 0 },
        });
        return toSync(requeued, yield* subjectsOf(tx, [requeued]));
      }),
    );
  });
}
