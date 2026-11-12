import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { INVOICE_PAYMENT_KINDS } from "@expendi-business/shared";

import { intentQuotes } from "./intent-quotes.js";
import { invoices } from "./invoices.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import { walletTransactions } from "./wallet-transactions.js";

export const invoicePaymentKind = pgEnum(
  "invoice_payment_kind",
  INVOICE_PAYMENT_KINDS,
);

/**
 * Money received for an invoice, or a note that it was paid elsewhere. An
 * invoice is paid while it has at least one. Never updated: a payment marked
 * or matched by hand is removed and recorded again, and one through the pay
 * link can't be removed because that money arrived for this invoice.
 *
 * - `link`: the customer paid the invoice's `invoice_payment` quote; the
 *   deposit watcher recorded it with the deposit it credited.
 * - `matched`: an admin linked a deposit already in the company wallet.
 * - `outside`: an admin recorded a payment Expendi never saw.
 *
 * A deposit pays at most one invoice.
 */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    invoiceId: uuid("invoice_id").notNull(),
    kind: invoicePaymentKind("kind").notNull(),
    intentQuoteId: uuid("intent_quote_id"),
    walletTransactionId: uuid("wallet_transaction_id"),
    /** USDC base units the company wallet received; null for `outside`. */
    amountUsdc: bigint("amount_usdc", { mode: "bigint" }),
    /** The Nairobi calendar day the money arrived. */
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    reference: text("reference"),
    note: text("note"),
    /** The admin who recorded it; null when the deposit watcher did. */
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "invoice_payments_invoice_organization_fk",
      columns: [table.invoiceId, table.organizationId],
      foreignColumns: [invoices.id, invoices.organizationId],
    }),
    foreignKey({
      name: "invoice_payments_intent_quote_organization_fk",
      columns: [table.intentQuoteId, table.organizationId],
      foreignColumns: [intentQuotes.id, intentQuotes.organizationId],
    }),
    foreignKey({
      name: "invoice_payments_wallet_transaction_organization_fk",
      columns: [table.walletTransactionId, table.organizationId],
      foreignColumns: [
        walletTransactions.id,
        walletTransactions.organizationId,
      ],
    }),
    // One quote is paid once; one deposit pays one invoice.
    unique("invoice_payments_intent_quote_id_unique").on(table.intentQuoteId),
    unique("invoice_payments_wallet_transaction_id_unique").on(
      table.walletTransactionId,
    ),
    index("invoice_payments_invoice_id_idx").on(table.invoiceId),
    check(
      "invoice_payments_kind_has_sources",
      sql`(${table.kind} = 'link' AND ${table.intentQuoteId} IS NOT NULL AND ${table.walletTransactionId} IS NOT NULL AND ${table.amountUsdc} IS NOT NULL) OR (${table.kind} = 'matched' AND ${table.intentQuoteId} IS NULL AND ${table.walletTransactionId} IS NOT NULL AND ${table.amountUsdc} IS NOT NULL) OR (${table.kind} = 'outside' AND ${table.intentQuoteId} IS NULL AND ${table.walletTransactionId} IS NULL AND ${table.amountUsdc} IS NULL)`,
    ),
    check(
      "invoice_payments_amount_positive",
      sql`${table.amountUsdc} IS NULL OR ${table.amountUsdc} > 0`,
    ),
  ],
);

export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
