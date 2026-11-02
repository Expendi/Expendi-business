import { sql } from "drizzle-orm";
import {
  check,
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
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
} from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const membershipRole = pgEnum("membership_role", MEMBERSHIP_ROLES);
export const membershipStatus = pgEnum(
  "membership_status",
  MEMBERSHIP_STATUSES,
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    role: membershipRole("role").notNull(),
    /** Accountants only, lowercased: they have no `users` row (spec §4). */
    email: text("email"),
    /** Accountants only; everyone else's name is `users.full_name`. */
    fullName: text("full_name"),
    status: membershipStatus("status").notNull().default("invited"),
    invitedBy: uuid("invited_by").references(() => users.id),
    /** The latest invite; null for the admin who created the company. */
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("memberships_organization_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    // Target of expenses' composite foreign key.
    unique("memberships_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("memberships_user_id_idx").on(table.userId),
    uniqueIndex("memberships_organization_email_unique")
      .on(table.organizationId, table.email)
      .where(sql`${table.email} IS NOT NULL`),
    check(
      "memberships_email_lowercase",
      sql`${table.email} = lower(${table.email})`,
    ),
    // Accountants get the export by email and have no login (spec §4);
    // everyone else logs in, so they must be a user.
    check(
      "memberships_identity_check",
      sql`(${table.role} = 'accountant' AND ${table.email} IS NOT NULL) OR (${table.role} <> 'accountant' AND ${table.userId} IS NOT NULL)`,
    ),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
