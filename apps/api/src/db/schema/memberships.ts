import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
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
    /**
     * Everyone signs in, accountants included (to the web dashboard, spec
     * §6.14); an invite creates the user from their email.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRole("role").notNull(),
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
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
