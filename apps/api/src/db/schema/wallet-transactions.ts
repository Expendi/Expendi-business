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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { WALLET_TRANSACTION_TYPES } from "@expendi-business/shared";

import { intentQuotes } from "./intent-quotes.js";
import { organizations } from "./organizations.js";
import { payouts } from "./payouts.js";
import { treasuryMoves } from "./treasury-moves.js";
import { walletChain, wallets } from "./wallets.js";

export const walletTransactionType = pgEnum(
  "wallet_transaction_type",
  WALLET_TRANSACTION_TYPES,
);

/**
 * The wallet's ledger. Append-only: the app role may only INSERT, so a
 * correction is a new row. `usdc_amount` is signed (credits positive,
 * debits negative), so the balance is the sum and must match the chain.
 *
 * It covers the company wallet on NEAR and the transit wallet on Base
 * together (docs/decisions/near-main-chain.md, "The ledger"), so each row
 * says which chain its transfer is on:
 *
 * - `base`: the transfer is one log of a transaction, found by `tx_hash`
 *   and `log_index`. Hex hashes compare without regard to case.
 * - `near`: the transfer is found by `receipt_id`, the log's position in
 *   that receipt (`log_index`) and its position in the log's event
 *   (`transfer_index`), which is the same whichever indexer reported it.
 *   `tx_hash` is base58 and case-sensitive: it is stored and compared
 *   exactly, never lowercased.
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
    /**
     * `base` unless the writer says otherwise: every row written before NEAR
     * became the main chain, and everything the transit wallet does, is on
     * Base. Code that records a NEAR transfer sets it.
     */
    chain: walletChain("chain").notNull().default("base"),
    usdcAmount: bigint("usdc_amount", { mode: "bigint" }).notNull(),
    txHash: text("tx_hash"),
    /** NEAR only: the receipt whose logs carry the transfer. Base58. */
    receiptId: text("receipt_id"),
    /**
     * On Base, the log's position in its block. On NEAR, the log's position
     * among its receipt's logs.
     */
    logIndex: integer("log_index"),
    /** NEAR only: the transfer's position in its log's event. */
    transferIndex: integer("transfer_index"),
    /** The block on Base, or the block height on NEAR. */
    blockNumber: bigint("block_number", { mode: "bigint" }),
    /** The sender of a credit, or the recipient of a debit. */
    counterpartyAddress: text("counterparty_address"),
    payoutId: uuid("payout_id").references(() => payouts.id),
    /** The move to or from Treasury a `to_treasury` or `from_treasury` row belongs to. */
    treasuryMoveId: uuid("treasury_move_id"),
    /**
     * The 1Click quote whose send a `to_treasury` debit records, and only
     * that. A refund coming back is a `from_treasury` row with no quote
     * link, so one quote has at most one debit but may also have its refund.
     */
    intentQuoteId: uuid("intent_quote_id"),
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
    // One on-chain transfer moves money once, whichever company it belongs
    // to; retries, duplicate webhooks and a watcher reading the same page
    // twice hit one of these two.
    uniqueIndex("wallet_transactions_base_transfer_unique")
      .on(sql`lower(${table.txHash})`, table.logIndex)
      .where(sql`${table.chain} = 'base'`),
    uniqueIndex("wallet_transactions_near_transfer_unique")
      .on(table.receiptId, table.logIndex, table.transferIndex)
      .where(sql`${table.chain} <> 'base'`),
    foreignKey({
      name: "wallet_transactions_treasury_move_organization_fk",
      columns: [table.treasuryMoveId, table.organizationId],
      foreignColumns: [treasuryMoves.id, treasuryMoves.organizationId],
    }),
    foreignKey({
      name: "wallet_transactions_intent_quote_organization_fk",
      columns: [table.intentQuoteId, table.organizationId],
      foreignColumns: [intentQuotes.id, intentQuotes.organizationId],
    }),
    // Target of invoice_payments' composite foreign key.
    unique("wallet_transactions_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("wallet_transactions_wallet_id_idx").on(table.walletId),
    // The Treasury types are compared as text: an enum value can't be used
    // in the transaction that adds it.
    check(
      "wallet_transactions_amount_sign",
      sql`(${table.type}::text IN ('deposit', 'refund', 'topup', 'from_treasury') AND ${table.usdcAmount} > 0) OR (${table.type}::text IN ('payout', 'withdrawal', 'to_treasury') AND ${table.usdcAmount} < 0)`,
    ),
    // Exactly the two Treasury types name their move. A debit to Treasury
    // names the quote it paid; a credit from Treasury may name the
    // `from_treasury` quote it delivered; a deposit may name the quote whose
    // delivery into a confidential account it records; no other type names a
    // quote.
    check(
      "wallet_transactions_treasury_has_move",
      sql`(${table.type}::text IN ('to_treasury', 'from_treasury')) = (${table.treasuryMoveId} IS NOT NULL)`,
    ),
    check(
      "wallet_transactions_quote_link_is_treasury",
      sql`(${table.type}::text = 'to_treasury') <= (${table.intentQuoteId} IS NOT NULL) AND (${table.intentQuoteId} IS NULL OR ${table.type}::text IN ('to_treasury', 'from_treasury', 'deposit'))`,
    ),
    // A delivery into a confidential account is credited once, when 1Click
    // reports it, and has no chain transaction to name. Debits are negative
    // and `from_treasury` credits carry a transaction, so both stay unbound.
    // The predicate can't name the enum: it must be immutable.
    uniqueIndex("wallet_transactions_quote_settled_credit_unique")
      .on(table.intentQuoteId)
      .where(
        sql`${table.intentQuoteId} IS NOT NULL AND ${table.txHash} IS NULL AND ${table.usdcAmount} > 0`,
      ),
    // A quote's send is debited once. Debits are the negative rows, so this
    // binds them only (the predicate can't name the enum: it must be
    // immutable). Credits that name a quote are kept once each by the
    // transfer index, so a delivery that arrives in two transfers is credited
    // in full.
    uniqueIndex("wallet_transactions_to_treasury_quote_unique")
      .on(table.intentQuoteId)
      .where(
        sql`${table.intentQuoteId} IS NOT NULL AND ${table.usdcAmount} < 0`,
      ),
    check(
      "wallet_transactions_payout_has_payout",
      sql`${table.type} <> 'payout' OR ${table.payoutId} IS NOT NULL`,
    ),
    // A payout or withdrawal is debited once.
    uniqueIndex("wallet_transactions_payout_debit_unique")
      .on(table.payoutId)
      .where(sql`${table.type} IN ('payout', 'withdrawal')`),
    // A deposit is a transfer on chain, or the settlement of a quote that
    // delivered into a confidential account, which has no chain transaction.
    check(
      "wallet_transactions_deposit_has_source",
      sql`${table.type} <> 'deposit' OR (${table.intentQuoteId} IS NULL AND ${table.txHash} IS NOT NULL AND ${table.logIndex} IS NOT NULL AND ${table.blockNumber} IS NOT NULL) OR (${table.intentQuoteId} IS NOT NULL AND ${table.chain} <> 'base' AND ${table.txHash} IS NULL AND ${table.receiptId} IS NULL AND ${table.logIndex} IS NULL AND ${table.transferIndex} IS NULL AND ${table.blockNumber} IS NULL)`,
    ),
    // A receipt and a position in an event are how a NEAR transfer is named,
    // always together; a Base transfer has neither.
    check(
      "wallet_transactions_receipt_is_near",
      sql`(${table.receiptId} IS NULL AND ${table.transferIndex} IS NULL) OR (${table.chain} <> 'base' AND ${table.receiptId} IS NOT NULL AND ${table.transferIndex} IS NOT NULL AND ${table.logIndex} IS NOT NULL)`,
    ),
    // Without its receipt a NEAR deposit could be credited twice.
    check(
      "wallet_transactions_near_deposit_has_receipt",
      sql`${table.chain} = 'base' OR ${table.type} <> 'deposit' OR ${table.receiptId} IS NOT NULL OR ${table.intentQuoteId} IS NOT NULL`,
    ),
    check(
      "wallet_transactions_positions_not_negative",
      sql`(${table.logIndex} IS NULL OR ${table.logIndex} >= 0) AND (${table.transferIndex} IS NULL OR ${table.transferIndex} >= 0)`,
    ),
    // A NEAR hash is 32 bytes in base58. A lowercased one, or a 0x hash
    // filed under the wrong chain, usually fails this.
    check(
      "wallet_transactions_near_hashes_are_base58",
      sql`${table.chain} = 'base' OR ((${table.txHash} IS NULL OR ${table.txHash} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') AND (${table.receiptId} IS NULL OR ${table.receiptId} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'))`,
    ),
  ],
);

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
