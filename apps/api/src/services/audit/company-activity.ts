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
import { memberships, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "../staff/paging.js";

/**
 * A company's own activity (spec §6.13, §6.14): its audit entries, for its
 * admins and accountants. The app role can't SELECT `audit_log`; the
 * `company_activity_log` definer function returns only the entries of the
 * company in the transaction's scope, and none unless the scope's role
 * reads the whole company.
 */

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

function toEntry(
  row: ActivityRow,
  names: ReadonlyMap<string, string>,
): ActivityEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at_utc,
    actor: {
      type: row.actor_type,
      name:
        row.actor_type === "user"
          ? (names.get(row.actor_id.toLowerCase()) ?? null)
          : null,
    },
    action: row.action,
    entity: { type: row.entity_type, id: row.entity_id },
    before: row.before,
    after: row.after,
  };
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
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const { rows } = yield* query(() =>
          tx.execute<ActivityRow>(sql`
            SELECT entry.*,
                   ${isoUtc(sql`entry.occurred_at`)} AS occurred_at_utc
            FROM company_activity_log(
              ${filters.actionPrefix ?? null}::text,
              ${filters.from ?? null}::date,
              ${filters.to ?? null}::date,
              ${cursor?.at ?? null}::timestamptz,
              ${cursor?.id ?? null}::uuid,
              ${filters.limit + 1}::integer
            ) AS entry`),
        );
        const page = rows.slice(0, filters.limit);
        const last = page.at(-1);
        const names = yield* memberNames(tx, tenant.organizationId, page);
        return {
          entries: page.map((row) => toEntry(row, names)),
          nextCursor:
            rows.length > filters.limit && last
              ? encodeCursor({ at: last.occurred_at_utc, id: last.id })
              : null,
        };
      }),
    );
  });
}
