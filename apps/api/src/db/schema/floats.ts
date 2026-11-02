import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  FLOAT_MOVEMENT_STATUSES,
  FLOAT_MOVEMENT_TYPES,
  FLOAT_STATUSES,
} from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { payouts } from "./payouts.js";
import { users } from "./users.js";

export const floatStatus = pgEnum("float_status", FLOAT_STATUSES);
export const floatMovementType = pgEnum(
  "float_movement_type",
  FLOAT_MOVEMENT_TYPES,
);
export const floatMovementStatus = pgEnum(
  "float_movement_status",
  FLOAT_MOVEMENT_STATUSES,
);

/**
 * A petty cash float (spec §6.22): money paid to one person ahead of
 * spending. Its balance is never stored: it's worked out from its
 * movements and its spending (`services/floats/balance.ts`). A person has
 * at most one open float. Row-level security lets admins see every float
 * and anyone else only their own.
 */
export const floats = pgTable(
  "floats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Who holds it: an employee, or an admin keeping the office cash box. */
    membershipId: uuid("membership_id").notNull(),
    status: floatStatus("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "floats_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    // Target of float_movements' and expenses' composite foreign keys.
    unique("floats_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("floats_one_open_per_membership")
      .on(table.membershipId)
      .where(sql`${table.status} = 'open'`),
    index("floats_organization_opened_idx").on(
      table.organizationId,
      table.openedAt,
    ),
    check(
      "floats_closed",
      sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL) AND (${table.closedAt} IS NULL) = (${table.closedBy} IS NULL)`,
    ),
  ],
);

export type FloatRow = typeof floats.$inferSelect;
export type NewFloat = typeof floats.$inferInsert;

/**
 * Money into or out of a float (spec §6.22, §10). An issue or top-up is a
 * payout to the holder (subject `float`, subject ID the movement's ID) and
 * follows it: `pending` while it waits for approval or is on its way, then
 * `paid` or `failed`. `payout_id` is its latest payout; a retry replaces
 * it. Returns and write-offs move no money through Expendi and are
 * `recorded` at once. Only status, the latest payout and when it was paid
 * ever change (column grants in the migration); the amount never does.
 */
export const floatMovements = pgTable(
  "float_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    floatId: uuid("float_id").notNull(),
    type: floatMovementType("type").notNull(),
    status: floatMovementStatus("status").notNull(),
    /** KES cents. */
    amountKes: bigint("amount_kes", { mode: "bigint" }).notNull(),
    payoutId: uuid("payout_id"),
    /** A return's note, or why the rest was written off when the float closed. */
    note: text("note"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "float_movements_float_organization_fk",
      columns: [table.floatId, table.organizationId],
      foreignColumns: [floats.id, floats.organizationId],
    }),
    foreignKey({
      name: "float_movements_payout_organization_fk",
      columns: [table.payoutId, table.organizationId],
      foreignColumns: [payouts.id, payouts.organizationId],
    }),
    // One payment at a time: a second can't be prepared while one is still
    // waiting for approval or on its way.
    uniqueIndex("float_movements_one_pending_per_float")
      .on(table.floatId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("float_movements_payout_id_unique")
      .on(table.payoutId)
      .where(sql`${table.payoutId} IS NOT NULL`),
    index("float_movements_float_created_idx").on(
      table.floatId,
      table.createdAt,
    ),
    check("float_movements_amount_positive", sql`${table.amountKes} > 0`),
    check(
      "float_movements_paid_through_expendi",
      sql`(${table.type} IN ('issue', 'top_up')) = (${table.payoutId} IS NOT NULL)`,
    ),
    check(
      "float_movements_status_for_type",
      sql`CASE WHEN ${table.type} IN ('issue', 'top_up') THEN ${table.status} IN ('pending', 'paid', 'failed') ELSE ${table.status} = 'recorded' END`,
    ),
    check(
      "float_movements_paid_at",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "float_movements_write_off_reason",
      sql`${table.type} <> 'write_off' OR (${table.note} IS NOT NULL AND length(btrim(${table.note})) > 0)`,
    ),
  ],
);

export type FloatMovementRow = typeof floatMovements.$inferSelect;
export type NewFloatMovement = typeof floatMovements.$inferInsert;
