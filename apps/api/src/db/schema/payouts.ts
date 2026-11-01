import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { PayoutRecipient } from "../../services/paycrest/recipient.js";
import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { payrollRuns } from "./payroll-runs.js";
import { users } from "./users.js";
import { wallets } from "./wallets.js";

export const payoutSubjectType = pgEnum("payout_subject_type", [
  "claim",
  "bill",
  "float",
]);

export const payoutProvider = pgEnum("payout_provider", [
  "paycrest",
  "onchain",
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
     * Set before Paycrest is asked for an order. Without an order ID, a set
     * value means the request may have reached Paycrest: never ask again.
     */
    orderRequestedAt: timestamp("order_requested_at", { withTimezone: true }),
    providerOrderId: text("provider_order_id"),
    rate: text("rate"),
    usdcAmount: bigint("usdc_amount", { mode: "bigint" }),
    feeUsdc: bigint("fee_usdc", { mode: "bigint" }),
    /** Exactly what is sent: the order amount plus Paycrest's fee. */
    amountToTransferUsdc: bigint("amount_to_transfer_usdc", {
      mode: "bigint",
    }),
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
    /** Paycrest's last reported order status, and when we last asked. */
    providerStatus: text("provider_status"),
    providerCheckedAt: timestamp("provider_checked_at", {
      withTimezone: true,
    }),
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
    uniqueIndex("payouts_idempotency_key_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    // A subject has at most one payout that isn't failed: it can't be paid
    // twice, and a retry is a new payout only after the last one failed.
    uniqueIndex("payouts_one_live_per_subject")
      .on(table.organizationId, table.subjectType, table.subjectId)
      .where(sql`${table.status} <> 'failed'`),
    uniqueIndex("payouts_provider_order_id_unique").on(table.providerOrderId),
    index("payouts_status_idx").on(table.status),
    check(
      "payouts_whole_shillings",
      sql`${table.provider} <> 'paycrest' OR ${table.amountKes} % 100 = 0`,
    ),
    check(
      "payouts_amounts_positive",
      sql`${table.requestedKesCents} > 0 AND ${table.amountKes} >= ${table.requestedKesCents} AND ${table.quotedUsdc} > 0 AND ${table.maxDebitUsdc} >= ${table.quotedUsdc}`,
    ),
    // Money only moves once we know exactly where and how much; through
    // Paycrest that also means an order.
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
