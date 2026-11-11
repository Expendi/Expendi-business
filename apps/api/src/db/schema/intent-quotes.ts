import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { companyWalletSends } from "./company-wallet-sends.js";
import { organizations } from "./organizations.js";
import { wallets } from "./wallets.js";

/**
 * Why Expendi asked NEAR Intents (the 1Click API) for a quote:
 *
 * - `base_hop`: company wallet to transit wallet, so a cash-out can be funded.
 * - `sweep`: transit wallet back to the company wallet.
 * - `fund_in`: a company adding money from another chain or asset.
 * - `usdc_payout`: company wallet to a USDC payee on Base or Solana.
 */
export const INTENT_QUOTE_PURPOSES = [
  "base_hop",
  "sweep",
  "fund_in",
  "usdc_payout",
] as const;
export type IntentQuotePurpose = (typeof INTENT_QUOTE_PURPOSES)[number];

/**
 * - `quoted`: saved; nothing has been sent to its deposit address yet.
 * - `depositing`: a send to its deposit address was started, or 1Click has
 *   seen one. The money may be with 1Click.
 * - `succeeded`: 1Click delivered to the recipient. Final.
 * - `refunded`: 1Click returned the deposit to the refund address. Final.
 * - `failed`: 1Click gave up on it. Final.
 * - `expired`: its deadline passed with nothing deposited. Final.
 * - `needs_review`: what happened is unclear; a person is checking it.
 */
export const INTENT_QUOTE_STATUSES = [
  "quoted",
  "depositing",
  "succeeded",
  "refunded",
  "failed",
  "expired",
  "needs_review",
] as const;
export type IntentQuoteStatus = (typeof INTENT_QUOTE_STATUSES)[number];

/**
 * Statuses in which a quote may still move money. An inbound transfer isn't
 * credited while one of the company's quotes is in these and could explain
 * it (decision record, "Telling internal transfers from deposits").
 */
export const UNSETTLED_INTENT_QUOTE_STATUSES = [
  "quoted",
  "depositing",
  "needs_review",
] as const satisfies readonly IntentQuoteStatus[];

/** Which side of the quote is exact, as 1Click names it. */
export const INTENT_QUOTE_SWAP_TYPES = ["EXACT_INPUT", "EXACT_OUTPUT"] as const;
export type IntentQuoteSwapType = (typeof INTENT_QUOTE_SWAP_TYPES)[number];

/** What 1Click's status endpoint reports for a deposit address. */
export const ONE_CLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type OneClickStatus = (typeof ONE_CLICK_STATUSES)[number];

export const intentQuotePurpose = pgEnum(
  "intent_quote_purpose",
  INTENT_QUOTE_PURPOSES,
);
export const intentQuoteStatus = pgEnum(
  "intent_quote_status",
  INTENT_QUOTE_STATUSES,
);
export const intentQuoteSwapType = pgEnum(
  "intent_quote_swap_type",
  INTENT_QUOTE_SWAP_TYPES,
);
export const oneClickStatus = pgEnum("one_click_status", ONE_CLICK_STATUSES);

/**
 * An amount of any asset in its smallest unit. A fund-in can start from an
 * asset with 18 or 24 decimals, which overflows a bigint column, so these
 * hold anything up to a u128.
 */
const assetAmount = (name: string) =>
  numeric(name, { precision: 39, scale: 0, mode: "bigint" });

/**
 * Every quote Expendi takes from NEAR Intents, saved before anything is sent
 * to its deposit address (docs/decisions/near-main-chain.md). A quote moves a
 * company's money between its own wallets or out to a payee; it is never a
 * ledger entry itself. Its transaction hashes are how the deposit watcher
 * tells an internal transfer from a deposit.
 */
export const intentQuotes = pgTable(
  "intent_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    walletId: uuid("wallet_id").notNull(),
    /**
     * Names what the quote is for, e.g. one payout's Base hop: the same key
     * never gets a second quote. A fresh attempt uses a new key.
     */
    quoteKey: text("quote_key").notNull(),
    purpose: intentQuotePurpose("purpose").notNull(),
    status: intentQuoteStatus("status").notNull().default("quoted"),
    swapType: intentQuoteSwapType("swap_type").notNull(),
    /** 1Click asset IDs, e.g. `nep141:…`. */
    originAsset: text("origin_asset").notNull(),
    destinationAsset: text("destination_asset").notNull(),
    /** What to send to the deposit address, in the origin asset. */
    amountIn: assetAmount("amount_in").notNull(),
    /**
     * `EXACT_OUTPUT` only: the least that still delivers `amountOut`. The
     * rest of `amountIn` is a buffer 1Click returns to the refund address.
     */
    minAmountIn: assetAmount("min_amount_in"),
    /** What the recipient receives, in the destination asset. */
    amountOut: assetAmount("amount_out").notNull(),
    /** `EXACT_INPUT` only: the least the recipient may receive. */
    minAmountOut: assetAmount("min_amount_out"),
    /**
     * Where the origin asset is sent, on the origin chain; exactly as 1Click
     * gave it. On NEAR it is a 64-hex implicit account.
     */
    depositAddress: text("deposit_address").notNull(),
    /** Who receives the destination asset, on the destination chain. */
    recipient: text("recipient").notNull(),
    /** Where 1Click returns the origin asset, on the origin chain. */
    refundTo: text("refund_to").notNull(),
    /** After this, 1Click refunds a deposit instead of delivering it. */
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    /**
     * 1Click's whole quote response, as received, with the signature that
     * was verified before the row was saved.
     */
    quoteResponse: jsonb("quote_response").$type<unknown>().notNull(),
    /**
     * The company wallet send that paid the deposit address, for a quote
     * the company wallet funds.
     */
    companyWalletSendId: uuid("company_wallet_send_id"),
    /**
     * Set immediately before the one attempt to pay the deposit address
     * from a wallet Expendi signs for. A set value means money may have
     * moved, whatever came back.
     */
    depositStartedAt: timestamp("deposit_started_at", { withTimezone: true }),
    /** Privy's ID for a deposit sent from the transit wallet. */
    depositPrivyTransactionId: text("deposit_privy_transaction_id"),
    /**
     * The transaction that paid the deposit address, once known: base58 on
     * NEAR (case-sensitive), a 0x hash on Base.
     */
    depositTxHash: text("deposit_tx_hash"),
    /** When 1Click was told about the deposit transaction. */
    depositSubmittedAt: timestamp("deposit_submitted_at", {
      withTimezone: true,
    }),
    /**
     * USDC base units the gas relayer sent the company wallet so the hop
     * costs the company nothing, saved before it is sent.
     */
    feeCoverUsdc: bigint("fee_cover_usdc", { mode: "bigint" }),
    /** The relayer's NEAR transaction that sent the fee cover. */
    feeCoverTxHash: text("fee_cover_tx_hash"),
    /**
     * The relayer's NEAR transaction that registered the deposit address
     * with the USDC contract.
     */
    depositRegistrationTxHash: text("deposit_registration_tx_hash"),
    /** 1Click's last reported status, and when we last asked. */
    oneClickStatus: oneClickStatus("one_click_status"),
    oneClickCheckedAt: timestamp("one_click_checked_at", {
      withTimezone: true,
    }),
    /**
     * The transactions 1Click's status lists, exactly as it gives them. A
     * transfer in one of these belongs to this quote. NEAR hashes are
     * case-sensitive; compare Base hashes without regard to case.
     */
    nearTxHashes: text("near_tx_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    originChainTxHashes: text("origin_chain_tx_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    destinationChainTxHashes: text("destination_chain_tx_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** What 1Click says reached the deposit address. */
    depositedAmount: assetAmount("deposited_amount"),
    /** What 1Click says the swap actually took and delivered. */
    swappedAmountIn: assetAmount("swapped_amount_in"),
    swappedAmountOut: assetAmount("swapped_amount_out"),
    /** What 1Click says it returned to the refund address. */
    refundedAmount: assetAmount("refunded_amount"),
    refundReason: text("refund_reason"),
    /** Why it failed or needs review, for whoever looks at it. */
    failure: text("failure"),
    /** When it reached a final status. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // The wallet must belong to the same company as the quote.
    foreignKey({
      name: "intent_quotes_wallet_organization_fk",
      columns: [table.walletId, table.organizationId],
      foreignColumns: [wallets.id, wallets.organizationId],
    }),
    foreignKey({
      name: "intent_quotes_company_wallet_send_organization_fk",
      columns: [table.companyWalletSendId, table.organizationId],
      foreignColumns: [
        companyWalletSends.id,
        companyWalletSends.organizationId,
      ],
    }),
    // Target of payouts' composite foreign keys.
    unique("intent_quotes_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("intent_quotes_quote_key_unique").on(
      table.organizationId,
      table.quoteKey,
    ),
    // 1Click gives each quote its own deposit address; a transfer to one
    // can only ever be for that quote.
    uniqueIndex("intent_quotes_deposit_address_unique").on(
      table.depositAddress,
    ),
    // One send pays one quote.
    uniqueIndex("intent_quotes_company_wallet_send_unique").on(
      table.companyWalletSendId,
    ),
    // "Does this company have a quote that could still move money?"
    index("intent_quotes_unsettled_idx")
      .on(table.organizationId)
      .where(sql`${table.status} IN ('quoted', 'depositing', 'needs_review')`),
    // "Is this transaction part of one of our quotes?"
    index("intent_quotes_near_tx_hashes_idx").using("gin", table.nearTxHashes),
    index("intent_quotes_destination_chain_tx_hashes_idx").using(
      "gin",
      table.destinationChainTxHashes,
    ),
    check(
      "intent_quotes_amounts_positive",
      sql`${table.amountIn} > 0 AND ${table.amountOut} > 0 AND (${table.minAmountIn} IS NULL OR (${table.minAmountIn} > 0 AND ${table.minAmountIn} <= ${table.amountIn})) AND (${table.minAmountOut} IS NULL OR (${table.minAmountOut} > 0 AND ${table.minAmountOut} <= ${table.amountOut}))`,
    ),
    check(
      "intent_quotes_settled_has_time",
      sql`(${table.status} IN ('succeeded', 'refunded', 'failed', 'expired')) = (${table.settledAt} IS NOT NULL)`,
    ),
    // Only a Base hop and a USDC payout start from the company wallet.
    check(
      "intent_quotes_send_is_from_company_wallet",
      sql`${table.companyWalletSendId} IS NULL OR ${table.purpose} IN ('base_hop', 'usdc_payout')`,
    ),
    // Expendi covers what a quote costs beyond the amount it delivers, for
    // the two purposes a company wallet funds.
    check(
      "intent_quotes_fee_cover_is_for_a_company_send",
      sql`(${table.feeCoverUsdc} IS NULL OR (${table.feeCoverUsdc} > 0 AND ${table.purpose} IN ('base_hop', 'usdc_payout'))) AND (${table.feeCoverTxHash} IS NULL OR ${table.feeCoverUsdc} IS NOT NULL)`,
    ),
    // Nothing was deposited for a quote that expired unused.
    check(
      "intent_quotes_expired_never_deposited",
      sql`${table.status} <> 'expired' OR (${table.depositStartedAt} IS NULL AND ${table.companyWalletSendId} IS NULL AND ${table.depositTxHash} IS NULL)`,
    ),
  ],
);

export type IntentQuote = typeof intentQuotes.$inferSelect;
export type NewIntentQuote = typeof intentQuotes.$inferInsert;
