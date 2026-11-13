import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { PayoutRecipient } from "../../services/paycrest/recipient.js";
import { timestamps } from "./columns.js";
import { intentQuotes } from "./intent-quotes.js";
import { organizations } from "./organizations.js";
import { payrollRuns } from "./payroll-runs.js";
import { users } from "./users.js";
import { wallets } from "./wallets.js";

/**
 * What a payout pays. A `withdrawal` is the company moving its own USDC to
 * an address on its allowlist (spec §6.9); its subject ID is the
 * withdrawal request's ID.
 */
export const payoutSubjectType = pgEnum("payout_subject_type", [
  "claim",
  "bill",
  "float",
  "withdrawal",
]);

/**
 * Who pays a payout out: a cash-out provider (Paycrest or Pretium) turns
 * USDC into shillings; `onchain` sends USDC itself.
 */
export const payoutProvider = pgEnum("payout_provider", [
  "paycrest",
  "onchain",
  "pretium",
]);

export const payoutMethod = pgEnum("payout_method", [
  "mpesa_phone",
  "mpesa_till",
  "mpesa_paybill",
  "bank",
  "usdc",
]);

/**
 * awaiting_approval → approved → order_created → funding → paying → paid
 * Any step before `funding` can end in `failed` with no money moved. From
 * `funding` on, USDC may have left the wallet, so an unclear outcome is
 * `needs_review` and a person resolves it (spec §6.8); never re-sent.
 */
export const PAYOUT_STATUSES = [
  "awaiting_approval",
  "approved",
  "order_created",
  "funding",
  "paying",
  "paid",
  "failed",
  "needs_review",
] as const;
export const payoutStatus = pgEnum("payout_status", PAYOUT_STATUSES);
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Statuses whose USDC is spoken for until the payout settles or fails. */
export const RESERVING_STATUSES = [
  "approved",
  "order_created",
  "funding",
] as const satisfies readonly PayoutStatus[];

/**
 * One payment of one subject (a claim, bill or float), possibly part of a
 * payroll run (spec §6.7, §10). The recipient is a snapshot taken when the
 * payout is prepared, so a later payee edit never changes it.
 */
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    walletId: uuid("wallet_id").notNull(),
    subjectType: payoutSubjectType("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /**
     * Which of the subject's orders this is. A salary above Paycrest's
     * largest order is paid as several (spec §7.5), parts 1, 2, …, each its
     * own payout under one approval; every other payment is part 1.
     */
    subjectPart: smallint("subject_part").notNull().default(1),
    payrollRunId: uuid("payroll_run_id"),
    /** Stable per attempt; preparing the same key again returns this row. */
    idempotencyKey: text("idempotency_key").notNull(),
    provider: payoutProvider("provider").notNull().default("paycrest"),
    method: payoutMethod("method").notNull(),
    recipient: jsonb("recipient").$type<PayoutRecipient>().notNull(),
    /** What the subject asked for, KES cents. */
    requestedKesCents: bigint("requested_kes_cents", {
      mode: "bigint",
    }).notNull(),
    /** What the recipient receives: whole shillings, in KES cents. */
    amountKes: bigint("amount_kes", { mode: "bigint" }).notNull(),
    quotedRate: text("quoted_rate").notNull(),
    quotedUsdc: bigint("quoted_usdc", { mode: "bigint" }).notNull(),
    /** The most USDC the approval lets leave the wallet for this payout. */
    maxDebitUsdc: bigint("max_debit_usdc", { mode: "bigint" }).notNull(),
    status: payoutStatus("status").notNull().default("awaiting_approval"),
    approvalId: uuid("approval_id"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /**
     * Set before the provider is asked: Paycrest for an order, Pretium to pay
     * against the sent hash. Without an order ID, a set value means the
     * request may have reached the provider: never ask again blindly.
     */
    orderRequestedAt: timestamp("order_requested_at", { withTimezone: true }),
    /**
     * Paycrest's order ID, or Pretium's transaction code. Pretium only gives
     * one once it is told the hash of the USDC sent, so a Pretium cash-out
     * has none until then.
     */
    providerOrderId: text("provider_order_id"),
    rate: text("rate"),
    usdcAmount: bigint("usdc_amount", { mode: "bigint" }),
    feeUsdc: bigint("fee_usdc", { mode: "bigint" }),
    /**
     * Exactly what is sent: the order amount plus Paycrest's fee, or what
     * Pretium is sent for the shillings.
     */
    amountToTransferUsdc: bigint("amount_to_transfer_usdc", {
      mode: "bigint",
    }),
    /** Paycrest's per-order deposit address, or Pretium's settlement address. */
    depositAddress: text("deposit_address"),
    depositValidUntil: timestamp("deposit_valid_until", {
      withTimezone: true,
    }),
    /** Set, under the row lock, immediately before the one send attempt. */
    fundingStartedAt: timestamp("funding_started_at", { withTimezone: true }),
    /** Privy's ID for the send; resolves the hash if the reply lacked it. */
    privyTransactionId: text("privy_transaction_id"),
    txHash: text("tx_hash"),
    /** The M-Pesa or bank receipt, once paid. */
    providerReference: text("provider_reference"),
    /** The provider's last reported status, and when we last asked. */
    providerStatus: text("provider_status"),
    providerCheckedAt: timestamp("provider_checked_at", {
      withTimezone: true,
    }),
    /**
     * The order's ID on Paycrest's Gateway contract (bytes32, lowercased),
     * from Paycrest's transaction logs. A Gateway refund names it, which
     * links the refund to this payout. Set once by sync, never changed.
     */
    gatewayOrderId: text("gateway_order_id"),
    /**
     * The Base hop quote that moved this cash-out's USDC to the transit
     * wallet. A payroll run hops once for its total, so its payouts share
     * one.
     */
    baseHopQuoteId: uuid("base_hop_quote_id"),
    /**
     * The quote that delivered a USDC payout to a payee on Base or Solana.
     * Null for a NEAR payee, who is paid straight from the company wallet.
     */
    deliveryQuoteId: uuid("delivery_quote_id"),
    /**
     * For a Pretium cash-out whose shillings were not paid after the USDC
     * was sent: set, under the row lock, immediately before the one refund
     * request to Pretium. Never ask twice.
     */
    refundRequestedAt: timestamp("refund_requested_at", {
      withTimezone: true,
    }),
    /**
     * The Base hash Pretium returned for the refund, lowercased: it links
     * the refund arriving in the transit wallet to this payout.
     */
    refundTxHash: text("refund_tx_hash"),
    failureReason: text("failure_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "payouts_wallet_organization_fk",
      columns: [table.walletId, table.organizationId],
      foreignColumns: [wallets.id, wallets.organizationId],
    }),
    foreignKey({
      name: "payouts_payroll_run_organization_fk",
      columns: [table.payrollRunId, table.organizationId],
      foreignColumns: [payrollRuns.id, payrollRuns.organizationId],
    }),
    foreignKey({
      name: "payouts_base_hop_quote_organization_fk",
      columns: [table.baseHopQuoteId, table.organizationId],
      foreignColumns: [intentQuotes.id, intentQuotes.organizationId],
    }),
    foreignKey({
      name: "payouts_delivery_quote_organization_fk",
      columns: [table.deliveryQuoteId, table.organizationId],
      foreignColumns: [intentQuotes.id, intentQuotes.organizationId],
    }),
    index("payouts_base_hop_quote_id_idx").on(table.baseHopQuoteId),
    // One quote delivers one payout.
    uniqueIndex("payouts_delivery_quote_id_unique").on(table.deliveryQuoteId),
    check(
      "payouts_base_hop_is_for_a_cash_out",
      sql`${table.baseHopQuoteId} IS NULL OR ${table.provider} <> 'onchain'`,
    ),
    check(
      "payouts_delivery_quote_is_for_usdc",
      sql`${table.deliveryQuoteId} IS NULL OR ${table.provider} = 'onchain'`,
    ),
    // Target of bills' composite foreign key.
    unique("payouts_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("payouts_idempotency_key_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    // A subject (each part of a split salary) has at most one payout that
    // isn't failed: it can't be paid twice, and a retry is a new payout only
    // after the last one failed.
    uniqueIndex("payouts_one_live_per_subject")
      .on(
        table.organizationId,
        table.subjectType,
        table.subjectId,
        table.subjectPart,
      )
      .where(sql`${table.status} <> 'failed'`),
    // Only a salary in a payroll run is ever split.
    check(
      "payouts_subject_part",
      sql`${table.subjectPart} >= 1 AND (${table.subjectPart} = 1 OR (${table.subjectType} = 'bill' AND ${table.payrollRunId} IS NOT NULL))`,
    ),
    // Two providers' IDs live in one column and may collide.
    uniqueIndex("payouts_provider_order_id_unique").on(
      table.provider,
      table.providerOrderId,
    ),
    // One refund refunds one payout.
    uniqueIndex("payouts_refund_tx_hash_unique")
      .on(table.refundTxHash)
      .where(sql`${table.refundTxHash} IS NOT NULL`),
    check(
      "payouts_refund_tx_hash_is_bytes32",
      sql`${table.refundTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    // Compared as text: Postgres won't use an enum value in the transaction
    // that added it, and pending migrations all run in one transaction.
    check(
      "payouts_refund_is_pretium",
      sql`${table.provider}::text = 'pretium' OR (${table.refundRequestedAt} IS NULL AND ${table.refundTxHash} IS NULL)`,
    ),
    index("payouts_status_idx").on(table.status),
    index("payouts_gateway_order_id_idx").on(table.gatewayOrderId),
    check(
      "payouts_gateway_order_id_is_bytes32",
      sql`${table.gatewayOrderId} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "payouts_whole_shillings",
      sql`${table.provider} = 'onchain' OR ${table.amountKes} % 100 = 0`,
    ),
    check(
      "payouts_amounts_positive",
      sql`${table.requestedKesCents} > 0 AND ${table.amountKes} >= ${table.requestedKesCents} AND ${table.quotedUsdc} > 0 AND ${table.maxDebitUsdc} >= ${table.quotedUsdc}`,
    ),
    // Money only moves once we know exactly where and how much; through
    // Paycrest that also means an order. Pretium names its transaction only
    // after the USDC is sent, so a Pretium cash-out funds without one.
    check(
      "payouts_funding_is_complete",
      sql`${table.status} NOT IN ('funding', 'paying', 'paid') OR (${table.amountToTransferUsdc} IS NOT NULL AND ${table.depositAddress} IS NOT NULL AND ${table.fundingStartedAt} IS NOT NULL AND (${table.provider} <> 'paycrest' OR ${table.providerOrderId} IS NOT NULL))`,
    ),
    check(
      "payouts_onchain_is_usdc",
      sql`(${table.provider} = 'onchain') = (${table.method} = 'usdc')`,
    ),
    check(
      "payouts_approved_has_approver",
      sql`${table.status} = 'awaiting_approval' OR ${table.status} = 'failed' OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL AND ${table.approvalId} IS NOT NULL)`,
    ),
  ],
);

export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
