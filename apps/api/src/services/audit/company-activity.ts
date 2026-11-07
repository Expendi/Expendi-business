import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  ActivityEntry,
  ActivityFilters,
  AuditActorType,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { BadRequest, DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Cursor } from "../staff/paging.js";
import { memberships, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "../staff/paging.js";
import { entityKey, entityLabels } from "./entity-labels.js";

/**
 * A company's own activity (spec §6.13, §6.14): its audit entries, for its
 * admins and accountants. The app role can't SELECT `audit_log`; the
 * `company_activity_log` definer function returns only the entries of the
 * company in the transaction's scope, and none unless the scope's role
 * reads the whole company.
 *
 * The function filters by action and date only. A person or record filter
 * is applied here, reading the log a batch at a time: a page stops after
 * `MAX_SCANS` batches with what it found so far, and its cursor carries on
 * from the last entry read.
 */

const SCAN_ROWS = 200;
const MAX_SCANS = 10;

interface ActivityRow extends Record<string, unknown> {
  readonly id: string;
  /** ISO 8601 in UTC, to the microsecond, for the cursor. */
  readonly occurred_at_utc: string;
  readonly actor_type: AuditActorType;
  readonly actor_id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: ActivityEntry["before"];
  readonly after: ActivityEntry["after"];
}

export interface ActivityPageView {
  readonly entries: ActivityEntry[];
  readonly nextCursor: string | null;
}

/**
 * Names for the page's people, through the company's own memberships, so
 * only people who are or were in this company are named.
 */
function memberNames(
  tx: Transaction,
  organizationId: string,
  rows: readonly ActivityRow[],
): Effect.Effect<Map<string, string>, DatabaseError> {
  const userIds = [
    ...new Set(
      rows
        .filter((row) => row.actor_type === "user" && UUID.test(row.actor_id))
        .map((row) => row.actor_id.toLowerCase()),
    ),
  ];
  if (userIds.length === 0) return Effect.succeed(new Map<string, string>());
  return query(() =>
    tx
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          inArray(memberships.userId, userIds),
        ),
      ),
  ).pipe(
    Effect.map(
      (people) =>
        new Map(
          people.map((person) => [person.id, person.fullName ?? person.email]),
        ),
    ),
  );
}

const userIdOf = (row: ActivityRow): string | null =>
  row.actor_type === "user" && UUID.test(row.actor_id)
    ? row.actor_id.toLowerCase()
    : null;

/** Approvals record the passkey approval each payment was part of. */
function approvalIdOf(after: ActivityEntry["after"]): string | null {
  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    return null;
  }
  const { approvalId } = after;
  return typeof approvalId === "string" && UUID.test(approvalId)
    ? approvalId.toLowerCase()
    : null;
}

function toEntry(
  row: ActivityRow,
  names: ReadonlyMap<string, string>,
  labels: ReadonlyMap<string, string>,
): ActivityEntry {
  const userId = userIdOf(row);
  return {
    id: row.id,
    occurredAt: row.occurred_at_utc,
    actor: {
      type: row.actor_type,
      id: userId,
      name: userId === null ? null : (names.get(userId) ?? null),
    },
    action: row.action,
    entity: {
      type: row.entity_type,
      id: row.entity_id,
      label:
        row.entity_id === null
          ? null
          : (labels.get(entityKey(row.entity_type, row.entity_id)) ?? null),
    },
    approvalId: approvalIdOf(row.after),
    before: row.before,
    after: row.after,
  };
}

function matchesPersonAndRecord(
  row: ActivityRow,
  filters: ActivityFilters,
): boolean {
  const { actor, entityType, entityId } = filters;
  if (actor === "system" || actor === "staff") {
    if (row.actor_type !== actor) return false;
  } else if (actor !== undefined && userIdOf(row) !== actor.toLowerCase()) {
    return false;
  }
  if (entityType !== undefined && row.entity_type !== entityType) return false;
  return (
    entityId === undefined ||
    row.entity_id?.toLowerCase() === entityId.toLowerCase()
  );
}

function readLog(
  tx: Transaction,
  filters: ActivityFilters,
  after: Cursor | null,
  maxRows: number,
): Effect.Effect<ActivityRow[], DatabaseError> {
  return query(() =>
    tx.execute<ActivityRow>(sql`
      SELECT entry.*,
             ${isoUtc(sql`entry.occurred_at`)} AS occurred_at_utc
      FROM company_activity_log(
        ${filters.actionPrefix ?? null}::text,
        ${filters.from ?? null}::date,
        ${filters.to ?? null}::date,
        ${after?.at ?? null}::timestamptz,
        ${after?.id ?? null}::uuid,
        ${maxRows}::integer
      ) AS entry`),
  ).pipe(Effect.map(({ rows }) => rows));
}

const cursorOf = (row: ActivityRow): Cursor => ({
  at: row.occurred_at_utc,
  id: row.id,
});

interface FoundPage {
  readonly rows: ActivityRow[];
  readonly next: Cursor | null;
}

/** One page straight from the log: `limit + 1` rows tell if there's more. */
function readPage(
  tx: Transaction,
  filters: ActivityFilters,
  cursor: Cursor | null,
): Effect.Effect<FoundPage, DatabaseError> {
  return readLog(tx, filters, cursor, filters.limit + 1).pipe(
    Effect.map((rows) => {
      const page = rows.slice(0, filters.limit);
      const last = page.at(-1);
      return {
        rows: page,
        next: rows.length > filters.limit && last ? cursorOf(last) : null,
      };
    }),
  );
}

/** A page of the entries that match the person or record filter. */
function scanPage(
  tx: Transaction,
  filters: ActivityFilters,
  cursor: Cursor | null,
): Effect.Effect<FoundPage, DatabaseError> {
  return Effect.gen(function* () {
    const found: ActivityRow[] = [];
    let at = cursor;
    for (let scan = 0; scan < MAX_SCANS; scan += 1) {
      const rows = yield* readLog(tx, filters, at, SCAN_ROWS);
      for (const row of rows) {
        at = cursorOf(row);
        if (!matchesPersonAndRecord(row, filters)) continue;
        found.push(row);
        if (found.length > filters.limit) {
          const page = found.slice(0, filters.limit);
          const last = page.at(-1);
          return { rows: page, next: last ? cursorOf(last) : null };
        }
      }
      if (rows.length < SCAN_ROWS) return { rows: found, next: null };
    }
    return { rows: found, next: at };
  });
}

/** One page of the company's activity matching `filters`, newest first. */
export function companyActivity(
  tenant: Tenant,
  filters: ActivityFilters,
): Effect.Effect<
  ActivityPageView,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const cursor = filters.cursor ? yield* decodeCursor(filters.cursor) : null;
    const filtered =
      filters.actor !== undefined || filters.entityType !== undefined;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const { rows, next } = filtered
          ? yield* scanPage(tx, filters, cursor)
          : yield* readPage(tx, filters, cursor);
        const names = yield* memberNames(tx, tenant.organizationId, rows);
        const labels = yield* entityLabels(
          tx,
          tenant.organizationId,
          rows.map((row) => ({ type: row.entity_type, id: row.entity_id })),
        );
        return {
          entries: rows.map((row) => toEntry(row, names, labels)),
          nextCursor: next ? encodeCursor(next) : null,
        };
      }),
    );
  });
}
