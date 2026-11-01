import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { users } from "./users.js";

/**
 * `approved` is interim: Telnyx accepted the code but the number isn't on
 * the user yet. Telnyx's check is one-time, so a retried confirm commits an
 * approved challenge without checking the code again.
 */
export const phoneVerificationStatus = pgEnum("phone_verification_status", [
  "pending",
  "approved",
  "verified",
  "expired",
]);

/**
 * SMS codes sent to confirm a payout number (spec §6.18), ported from the
 * consumer backend. Telnyx Verify generates and checks the code, so it is
 * never stored. A user has at most one pending challenge: starting again
 * supersedes it.
 */
export const phoneVerificationChallenges = pgTable(
  "phone_verification_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The number being confirmed, E.164. */
    phone: text("phone").notNull(),
    /** Telnyx's verification ID from the latest send. */
    providerRef: text("provider_ref"),
    status: phoneVerificationStatus("status").notNull().default("pending"),
    /** Wrong codes entered. */
    attempts: integer("attempts").notNull().default(0),
    /** Codes sent, the first included. */
    sendCount: integer("send_count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("phone_verification_challenges_user_id_idx").on(
      table.userId,
      table.lastSentAt,
    ),
    uniqueIndex("phone_verification_challenges_one_pending")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "phone_verification_challenges_counts",
      sql`${table.attempts} >= 0 AND ${table.sendCount} >= 1`,
    ),
  ],
);

export type PhoneVerificationChallenge =
  typeof phoneVerificationChallenges.$inferSelect;
