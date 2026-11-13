import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  TREASURY_MOVE_DIRECTIONS,
  TREASURY_MOVE_STATUSES,
} from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import { wallets } from "./wallets.js";

export const treasuryMoveDirection = pgEnum(
  "treasury_move_direction",
  TREASURY_MOVE_DIRECTIONS,
);
export const treasuryMoveStatus = pgEnum(
  "treasury_move_status",
  TREASURY_MOVE_STATUSES,
);

/**
 * One admin action that moves a company's USDC between its company wallet and
 * its Treasury wallet (docs/work/treasury/spec.md, "Ledger and data"). The
 * move itself is never a ledger entry: its `to_treasury` and `from_treasury`
 * rows are, and each links back here.
 *
 * Only one move per company is unsettled at a time, and while it is, the part
 * of `requested_usdc` not yet debited is reserved (`availableUsdc`).
 */
export const treasuryMoves = pgTable(
  "treasury_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    walletId: uuid("wallet_id").notNull(),
    direction: treasuryMoveDirection("direction").notNull(),
    /** USDC base units the admin asked to move. */
    requestedUsdc: bigint("requested_usdc", { mode: "bigint" }).notNull(),
    /** A move to the wallet of everything in the vault, whatever it is by then. */
    isAll: boolean("is_all").notNull().default(false),
    status: treasuryMoveStatus("status").notNull().default("open"),
    /** What left the company wallet, or what reached it; null until settled. */
    movedUsdc: bigint("moved_usdc", { mode: "bigint" }),
    /** The difference between the two ends; null until settled. */
    costUsdc: bigint("cost_usdc", { mode: "bigint" }),
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => users.id),
    /** The passkey approval the admin confirmed it with. */
    approvalId: uuid("approval_id").notNull(),
    /** Why it failed or needs review, for whoever looks at it. */
    failure: text("failure"),
    /** When it reached a final status. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // The wallet must belong to the same company as the move.
    foreignKey({
      name: "treasury_moves_wallet_organization_fk",
      columns: [table.walletId, table.organizationId],
      foreignColumns: [wallets.id, wallets.organizationId],
    }),
    // Target of the composite foreign keys of wallet_transactions and
    // intent_quotes.
    unique("treasury_moves_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    // One move at a time: with two, the reservation of the first could be
    // spent by the second.
    uniqueIndex("treasury_moves_one_unsettled_per_company")
      .on(table.organizationId)
      .where(sql`${table.status} IN ('open', 'needs_review')`),
    check("treasury_moves_requested_positive", sql`${table.requestedUsdc} > 0`),
    // Compared as text: an enum value can't be used in the transaction that
    // adds it.
    check(
      "treasury_moves_all_is_to_wallet",
      sql`NOT ${table.isAll} OR ${table.direction}::text = 'to_wallet'`,
    ),
    check(
      "treasury_moves_moved_not_negative",
      sql`${table.movedUsdc} IS NULL OR ${table.movedUsdc} >= 0`,
    ),
    check(
      "treasury_moves_settled_has_time",
      sql`(${table.status} IN ('completed', 'returned', 'failed')) = (${table.settledAt} IS NOT NULL)`,
    ),
  ],
);

export type TreasuryMove = typeof treasuryMoves.$inferSelect;
export type NewTreasuryMove = typeof treasuryMoves.$inferInsert;
