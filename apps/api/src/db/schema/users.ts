import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";

/**
 * Global, not company-owned: one person can belong to many companies.
 *
 * - `email` is the login identity (Privy email + passkey), stored lowercased.
 * - `privyUserId` is null until the person first logs in (an invite creates
 *   the row from their email).
 * - `phone` is the M-Pesa payout number. It is set only once the person has
 *   confirmed it with an SMS code (spec §6.18), so non-null means verified.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    privyUserId: text("privy_user_id").unique(),
    email: text("email").notNull().unique(),
    phone: text("phone").unique(),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    fullName: text("full_name"),
    ...timestamps,
  },
  (table) => [
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    check(
      "users_phone_verified",
      sql`(${table.phone} IS NULL) = (${table.phoneVerifiedAt} IS NULL)`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
