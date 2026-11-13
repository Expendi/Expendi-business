import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { staffUsers } from "./staff-users.js";

export const STAFF_CONFIRMATION_PURPOSES = [
  "resolve_payout",
  "pause_payouts",
  "unpause_payouts",
  "resolve_intent_quote",
  "change_cash_out_provider",
  "return_stranded_deposit",
  "resume_treasury_return",
] as const;
export type StaffConfirmationPurpose =
  (typeof STAFF_CONFIRMATION_PURPOSES)[number];

export const staffConfirmationPurpose = pgEnum(
  "staff_confirmation_purpose",
  STAFF_CONFIRMATION_PURPOSES,
);

/**
 * The second confirmation a staff action needs (spec §6.15): resolving a
 * stuck payout or NEAR Intents quote, pausing or unpausing payouts, and
 * changing the active cash-out provider, and sending a Treasury move's USDC
 * back to the company wallet. Preparing the action writes a row
 * and hands the staff member a token; confirming with it applies exactly
 * what was prepared, once, before it expires.
 *
 * Not company data. The API may insert and read rows, and spend one; a
 * trigger refuses any other change, the owner's included.
 */
export const staffConfirmations = pgTable(
  "staff_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id),
    purpose: staffConfirmationPurpose("purpose").notNull(),
    /** The payout's or quote's ID, the company's ID, or `platform`. */
    target: text("target").notNull(),
    /** What confirming applies, e.g. the outcome and the reason. */
    params: jsonb("params").$type<Record<string, string>>().notNull(),
    /** SHA-256 of the token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** SHA-256 over the purpose, target, params and staff member. */
    intentHash: text("intent_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("staff_confirmations_token_hash_unique").on(table.tokenHash),
    check(
      "staff_confirmations_spent_before_expiry",
      sql`${table.usedAt} IS NULL OR ${table.usedAt} <= ${table.expiresAt}`,
    ),
  ],
);

export type StaffConfirmation = typeof staffConfirmations.$inferSelect;
