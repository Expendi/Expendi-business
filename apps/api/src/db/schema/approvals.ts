import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Passkeys an admin enrolled to approve money actions (spec §7.3). Expendi's
 * own WebAuthn credentials, separate from Privy login (Dennis, 2026-11-01).
 */
export const approvalPasskeys = pgTable(
  "approval_passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** base64url, as WebAuthn reports it. */
    credentialId: text("credential_id").notNull(),
    /** COSE public key, base64url. */
    publicKey: text("public_key").notNull(),
    /** The authenticator's signature counter; a decrease means a clone. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: text("transports").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("approval_passkeys_credential_id_unique").on(
      table.credentialId,
    ),
    index("approval_passkeys_user_id_idx").on(table.userId),
  ],
);

export const webauthnPurpose = pgEnum("webauthn_purpose", [
  "register_passkey",
  "approve_payouts",
  "change_allowlist",
  "change_payee",
  "change_salary",
  "change_payroll_margin",
  "manage_cards",
  "load_card_balance",
  "reveal_card",
  "turn_on_treasury",
  "move_to_treasury",
  "move_to_wallet",
]);

/**
 * One-time WebAuthn challenges. For an approval, the challenge is derived
 * from the hash of exactly what is being approved (`intent_hash`), so the
 * passkey signature is bound to those payouts and amounts; it is consumed
 * once (`used_at`) and expires within minutes.
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id").references(() => organizations.id),
    purpose: webauthnPurpose("purpose").notNull(),
    /** base64url */
    challenge: text("challenge").notNull(),
    intentHash: text("intent_hash"),
    payoutIds: uuid("payout_ids").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("webauthn_challenges_user_id_idx").on(table.userId),
    // Every confirmation but enrolment is bound to a company and an intent;
    // a payout approval also names its payouts.
    check(
      "webauthn_challenges_confirmation_is_bound",
      sql`${table.purpose} = 'register_passkey' OR (${table.organizationId} IS NOT NULL AND ${table.intentHash} IS NOT NULL AND (${table.purpose} <> 'approve_payouts' OR ${table.payoutIds} IS NOT NULL))`,
    ),
  ],
);

export type ApprovalPasskey = typeof approvalPasskeys.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
