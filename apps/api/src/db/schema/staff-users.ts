import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { STAFF_ROLES, STAFF_STATUSES } from "@expendi-business/shared";

import { timestamps } from "./columns.js";

export const staffRole = pgEnum("staff_role", STAFF_ROLES);
export const staffStatus = pgEnum("staff_status", STAFF_STATUSES);

/**
 * The Expendi team's internal admin accounts (spec §6.15). Global, not
 * company-owned, and separate from `users`: staff are never company members.
 *
 * Only the owner role writes it (`scripts/add-staff.ts`). The API has no
 * grant on the table; it resolves a signed-in email to an active staff
 * member through `active_staff_by_email`.
 */
export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    role: staffRole("role").notNull(),
    status: staffStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    check(
      "staff_users_email_lowercase",
      sql`${table.email} = lower(${table.email})`,
    ),
  ],
);

export type StaffUser = typeof staffUsers.$inferSelect;
