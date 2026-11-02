import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  AuditActorType,
  AuditSearchFilters,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { BadRequest, DatabaseError } from "../../errors.js";
import { query } from "../../db/scope.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The staff audit log viewer (spec §6.13, §6.15, T27). Read-only: it runs
 * the `staff_search_audit_log` definer function, which returns rows and
 * can't change any; the app role still has no SELECT, UPDATE or DELETE on
 * `audit_log`.
 */

interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  /** ISO 8601 in UTC, to the microsecond. */
  readonly occurred_at_utc: string;
  readonly actor_type: AuditActorType;
  readonly actor_id: string;
  readonly organization_id: string | null;
  readonly organization_name: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly request_id: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

export interface AuditEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly type: AuditActorType;
    readonly id: string;
    readonly email: string | null;
  };
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string | null };
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditPage {
  readonly entries: AuditEntryView[];
  readonly nextCursor: string | null;
}

function idList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function actorIds(rows: readonly AuditRow[], type: AuditActorType): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.actor_type === type && UUID.test(row.actor_id))
        .map((row) => row.actor_id.toLowerCase()),
    ),
  ];
}

/** Emails for the page's staff and user actors, keyed by `<type>:<id>`. */
function actorEmails(
  tx: Transaction,
  rows: readonly AuditRow[],
): Effect.Effect<Map<string, string>, DatabaseError> {
  return Effect.gen(function* () {
    const emails = new Map<string, string>();
    const staffIds = actorIds(rows, "staff");
    if (staffIds.length > 0) {
      const { rows: staff } = yield* query(() =>
        tx.execute<{ staff_user_id: string; email: string }>(
          sql`SELECT staff_user_id, email FROM staff_emails_by_id(ARRAY[${idList(staffIds)}]::uuid[])`,
        ),
      );
      for (const row of staff)
        emails.set(`staff:${row.staff_user_id}`, row.email);
    }
    const userIds = actorIds(rows, "user");
    if (userIds.length > 0) {
      const { rows: users } = yield* query(() =>
        tx.execute<{ user_id: string; email: string }>(
          sql`SELECT user_id, email FROM user_emails_by_id(ARRAY[${idList(userIds)}]::uuid[])`,
        ),
      );
      for (const row of users) emails.set(`user:${row.user_id}`, row.email);
    }
    return emails;
  });
}

function toView(row: AuditRow, emails: Map<string, string>): AuditEntryView {
  return {
    id: row.id,
    occurredAt: row.occurred_at_utc,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      email:
        emails.get(`${row.actor_type}:${row.actor_id.toLowerCase()}`) ?? null,
    },
    organization:
      row.organization_id === null
        ? null
        : {
            id: row.organization_id,
            name: row.organization_name ?? row.organization_id,
          },
    action: row.action,
    entity: { type: row.entity_type, id: row.entity_id },
    before: row.before,
    after: row.after,
    requestId: row.request_id,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

/** One page of audit entries matching `filters`, newest first. */
export function searchAuditLog(
  filters: AuditSearchFilters,
): Effect.Effect<AuditPage, BadRequest | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const cursor = filters.cursor ? yield* decodeCursor(filters.cursor) : null;
    return yield* withStaffReadScope({}, (tx) =>
      Effect.gen(function* () {
        const { rows } = yield* query(() =>
          tx.execute<AuditRow>(sql`
            SELECT entry.*,
                   ${isoUtc(sql`entry.occurred_at`)} AS occurred_at_utc
            FROM staff_search_audit_log(
              ${filters.organizationId ?? null}::uuid,
              ${filters.actorType ?? null}::audit_actor_type,
              ${filters.actorId ?? null}::text,
              ${filters.action ?? null}::text,
              ${filters.actionPrefix ?? null}::text,
              ${filters.entityType ?? null}::text,
              ${filters.entityId ?? null}::text,
              ${filters.from ?? null}::date,
              ${filters.to ?? null}::date,
              ${cursor?.at ?? null}::timestamptz,
              ${cursor?.id ?? null}::uuid,
              ${filters.limit + 1}::integer
            ) AS entry`),
        );
        const page = rows.slice(0, filters.limit);
        const last = page.at(-1);
        const emails = yield* actorEmails(tx, page);
        return {
          entries: page.map((row) => toView(row, emails)),
          nextCursor:
            rows.length > filters.limit && last
              ? encodeCursor({ at: last.occurred_at_utc, id: last.id })
              : null,
        };
      }),
    );
  });
}
