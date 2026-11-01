import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { WALLET_TRANSACTION_TYPES } from "@expendi-business/shared";

import { organizations } from "./organizations.js";
import { payouts } from "./payouts.js";
import { wallets } from "./wallets.js";

export const walletTransactionType = pgEnum(
  "wallet_transaction_type",
  WALLET_TRANSACTION_TYPES,
);

/**
 * The wallet's ledger. Append-only: the app role may only INSERT, so a
 * correction is a new row. `usdc_amount` is signed (credits positive,
 * debits negative), so the balance is the sum and must match the chain.
 */
export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    walletId: uuid("wallet_id").notNull(),
    type: walletTransactionType("type").notNull(),
    usdcAmount: bigint("usdc_amount", { mode: "bigint" }).notNull(),
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    /** The sender of a credit, or the recipient of a debit. */
    counterpartyAddress: text("counterparty_address"),
    payoutId: uuid("payout_id").references(() => payouts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The wallet must belong to the same company as the ledger row.
    foreignKey({
      name: "wallet_transactions_wallet_organization_fk",
      columns: [table.walletId, table.organizationId],
      foreignColumns: [wallets.id, wallets.organizationId],
    }),
    // One on-chain transfer log moves money once, whichever company it
    // belongs to; retries and duplicate webhooks hit this.
    uniqueIndex("wallet_transactions_tx_log_unique").on(
      sql`lower(${table.txHash})`,
      table.logIndex,
    ),
    index("wallet_transactions_wallet_id_idx").on(table.walletId),
    check(
      "wallet_transactions_amount_sign",
      sql`(${table.type} IN ('deposit', 'refund', 'topup') AND ${table.usdcAmount} > 0) OR (${table.type} IN ('payout', 'withdrawal') AND ${table.usdcAmount} < 0)`,
    ),
    check(
      "wallet_transactions_payout_has_payout",
      sql`${table.type} <> 'payout' OR ${table.payoutId} IS NOT NULL`,
    ),
    // A payout is debited once.
    uniqueIndex("wallet_transactions_payout_debit_unique")
      .on(table.payoutId)
      .where(sql`${table.type} = 'payout'`),
    check(
      "wallet_transactions_deposit_is_onchain",
      sql`${table.type} <> 'deposit' OR (${table.txHash} IS NOT NULL AND ${table.logIndex} IS NOT NULL AND ${table.blockNumber} IS NOT NULL)`,
    ),
  ],
);

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
