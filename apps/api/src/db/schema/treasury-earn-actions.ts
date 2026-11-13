import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { intentQuotes } from "./intent-quotes.js";
import { organizations } from "./organizations.js";
import { treasuryMoves } from "./treasury-moves.js";

export const TREASURY_EARN_KINDS = ["deposit", "withdraw"] as const;
export type TreasuryEarnKind = (typeof TREASURY_EARN_KINDS)[number];

/**
 * - `saved`: the row exists; Privy hasn't answered the call yet, or its
 *   answer was lost. The call is repeated with the same key, never a new one.
 * - `pending`: Privy has the action and it hasn't finished.
 * - `succeeded`: the vault took, or gave back, exactly `raw_amount`.
 * - `rejected`: Privy answered with a 4xx, or the action was rejected: nothing
 *   was signed.
 * - `failed`: a transaction was sent and reverted.
 */
export const TREASURY_EARN_STATUSES = [
  "saved",
  "pending",
  "succeeded",
  "rejected",
  "failed",
] as const;
export type TreasuryEarnStatus = (typeof TREASURY_EARN_STATUSES)[number];

export const treasuryEarnKind = pgEnum(
  "treasury_earn_kind",
  TREASURY_EARN_KINDS,
);
export const treasuryEarnStatus = pgEnum(
  "treasury_earn_status",
  TREASURY_EARN_STATUSES,
);

/**
 * One Privy Earn call for a Treasury move (docs/work/treasury/spec.md,
 * "Ledger and data"): a deposit into the vault for a part of a move to
 * Treasury, or a withdrawal from it. The row is saved before Privy is
 * called, and Privy's idempotency key and `reference_id` are both
 * `reference_id`, so a repeated call can't act twice. A new attempt after a
 * rejection is a new row with a new reference.
 */
export const treasuryEarnActions = pgTable(
  "treasury_earn_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    treasuryMoveId: uuid("treasury_move_id").notNull(),
    /**
     * The quote this call follows: the part whose delivery a deposit puts
     * in the vault. Null for a withdrawal, which the quote follows instead.
     */
    intentQuoteId: uuid("intent_quote_id"),
    kind: treasuryEarnKind("kind").notNull(),
    /** Which try this is for its quote, from 1. */
    attempt: integer("attempt").notNull().default(1),
    /** `tr-<id>-<attempt>`: Privy's idempotency key and `reference_id`. */
    referenceId: text("reference_id").notNull(),
    /** USDC base units. */
    rawAmount: bigint("raw_amount", { mode: "bigint" }).notNull(),
    /** Vault shares Privy reports for the action, once it has. */
    shareAmount: bigint("share_amount", { mode: "bigint" }),
    privyActionId: text("privy_action_id"),
    status: treasuryEarnStatus("status").notNull().default("saved"),
    /** The step's `bundle_transaction_hash`, once Privy reports it. */
    txHash: text("tx_hash"),
    /**
     * A withdrawal only: the USDC that transaction's logs show reaching the
     * Treasury wallet, which a vault may fill in part. Saved once, and what a
     * move to the wallet sends back, never the wallet's whole balance.
     */
    deliveredUsdc: bigint("delivered_usdc", { mode: "bigint" }),
    /**
     * Set immediately before the first call to Privy. A row that has it and
     * is still `saved` is repeating a call whose outcome wasn't known.
     */
    callStartedAt: timestamp("call_started_at", { withTimezone: true }),
    failure: text("failure"),
    /** When it reached a final status. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "treasury_earn_actions_move_organization_fk",
      columns: [table.treasuryMoveId, table.organizationId],
      foreignColumns: [treasuryMoves.id, treasuryMoves.organizationId],
    }),
    foreignKey({
      name: "treasury_earn_actions_quote_organization_fk",
      columns: [table.intentQuoteId, table.organizationId],
      foreignColumns: [intentQuotes.id, intentQuotes.organizationId],
    }),
    uniqueIndex("treasury_earn_actions_reference_id_unique").on(
      table.referenceId,
    ),
    uniqueIndex("treasury_earn_actions_privy_action_id_unique")
      .on(table.privyActionId)
      .where(sql`${table.privyActionId} IS NOT NULL`),
    unique("treasury_earn_actions_attempt_unique").on(
      table.treasuryMoveId,
      table.intentQuoteId,
      table.kind,
      table.attempt,
    ),
    // One call at a time per move: a second could act on the same USDC.
    uniqueIndex("treasury_earn_actions_one_live_per_move")
      .on(table.treasuryMoveId)
      .where(sql`${table.status} IN ('saved', 'pending')`),
    // A part's USDC goes into the vault once.
    uniqueIndex("treasury_earn_actions_one_deposit_per_quote")
      .on(table.intentQuoteId)
      .where(
        sql`${table.kind} = 'deposit' AND ${table.status} IN ('saved', 'pending', 'succeeded')`,
      ),
    // A move to the wallet withdraws once, whatever came of it: a rejected
    // or failed withdrawal ends the move, and the admin starts a new one.
    uniqueIndex("treasury_earn_actions_one_withdrawal_per_move")
      .on(table.treasuryMoveId)
      .where(sql`${table.kind} = 'withdraw'`),
    check(
      "treasury_earn_actions_delivered_is_a_withdrawal",
      sql`${table.deliveredUsdc} IS NULL OR (${table.kind}::text = 'withdraw' AND ${table.status}::text = 'succeeded' AND ${table.deliveredUsdc} > 0)`,
    ),
    check(
      "treasury_earn_actions_raw_amount_positive",
      sql`${table.rawAmount} > 0`,
    ),
    check("treasury_earn_actions_attempt_positive", sql`${table.attempt} > 0`),
    // Privy's limit on a reference ID.
    check(
      "treasury_earn_actions_reference_id_length",
      sql`char_length(${table.referenceId}) <= 64`,
    ),
    check(
      "treasury_earn_actions_deposit_has_quote",
      sql`(${table.kind}::text = 'deposit') <= (${table.intentQuoteId} IS NOT NULL)`,
    ),
    // Compared as text: an enum value can't be used in the transaction that
    // adds it.
    check(
      "treasury_earn_actions_acted_has_action_id",
      sql`${table.status}::text NOT IN ('pending', 'succeeded', 'failed') OR ${table.privyActionId} IS NOT NULL`,
    ),
    check(
      "treasury_earn_actions_settled_has_time",
      sql`(${table.status}::text IN ('succeeded', 'rejected', 'failed')) = (${table.settledAt} IS NOT NULL)`,
    ),
  ],
);

export type TreasuryEarnAction = typeof treasuryEarnActions.$inferSelect;
export type NewTreasuryEarnAction = typeof treasuryEarnActions.$inferInsert;
