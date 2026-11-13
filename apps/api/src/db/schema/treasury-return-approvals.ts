import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { staffConfirmations } from "./staff-confirmations.js";
import { staffUsers } from "./staff-users.js";
import { treasuryMoves } from "./treasury-moves.js";

export const TREASURY_RETURN_KINDS = [
  "return_stranded_deposit",
  "resume_return",
] as const;
export type TreasuryReturnKind = (typeof TREASURY_RETURN_KINDS)[number];

/**
 * A staff member's approval to send a Treasury move's USDC back from the
 * Treasury wallet to the company wallet. Staff only record this and reopen
 * the move; the `treasury-moves` job sends, and only what is still owed at
 * that moment, never more than `approved_usdc`. The job marks the approval
 * used (`consumed_at`) when it takes the return quote, so an approval is
 * carried out once.
 */
export const treasuryReturnApprovals = pgTable(
  "treasury_return_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    treasuryMoveId: uuid("treasury_move_id").notNull(),
    kind: text("kind").$type<TreasuryReturnKind>().notNull(),
    /** USDC base units owed back when staff confirmed. */
    approvedUsdc: bigint("approved_usdc", { mode: "bigint" }).notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => staffUsers.id),
    reason: text("reason").notNull(),
    confirmationId: uuid("confirmation_id")
      .notNull()
      .references(() => staffConfirmations.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "treasury_return_approvals_move_organization_fk",
      columns: [table.treasuryMoveId, table.organizationId],
      foreignColumns: [treasuryMoves.id, treasuryMoves.organizationId],
    }),
    // One approval waiting per move: the job would otherwise not know which to carry out.
    uniqueIndex("treasury_return_approvals_one_pending_per_move")
      .on(table.treasuryMoveId)
      .where(sql`${table.consumedAt} IS NULL`),
    check(
      "treasury_return_approvals_kind",
      sql`${table.kind} IN ('return_stranded_deposit', 'resume_return')`,
    ),
    check(
      "treasury_return_approvals_amount_positive",
      sql`${table.approvedUsdc} > 0`,
    ),
  ],
);

export type TreasuryReturnApproval =
  typeof treasuryReturnApprovals.$inferSelect;
