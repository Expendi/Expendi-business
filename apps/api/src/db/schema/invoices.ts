import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { Invoice } from "@expendi-business/shared";
import { INVOICE_STATUSES, INVOICE_TERMS } from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { customers } from "./customers.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const invoiceStatus = pgEnum("invoice_status", INVOICE_STATUSES);
export const invoiceTerms = pgEnum("invoice_terms", INVOICE_TERMS);

/**
 * An invoice in US dollars (docs/decisions/crypto-invoicing.md). Admins write
 * them and accountants read them, down to row-level security. Employees see
 * none.
 *
 * - Money is whole cents. The app computes the line amounts, subtotal, tax
 *   and total and stores them; the database only checks they add up.
 * - `draft` is editable and deletable. Sending sets `bill_to`, `from_party`,
 *   `public_id` and `sent_at` together and locks the number.
 * - Overdue is not a status: an open invoice past `due_on`, a Nairobi date.
 * - Paying through the pay link after the invoice was voided makes it paid;
 *   the void fields are cleared and the audit log keeps what they said.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    customerId: uuid("customer_id").notNull(),
    /** Unique per company; a deleted draft frees its number, a void keeps it. */
    number: text("number").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    terms: invoiceTerms("terms").notNull().default("net_30"),
    issueOn: date("issue_on", { mode: "string" }).notNull(),
    /** Set from the terms when saved; chosen by the admin for custom terms. */
    dueOn: date("due_on", { mode: "string" }).notNull(),
    /** Basis points on the subtotal; null for no tax. */
    taxRateBps: integer("tax_rate_bps"),
    taxLabel: text("tax_label").notNull().default("VAT"),
    subtotalCents: bigint("subtotal_cents", { mode: "bigint" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "bigint" }).notNull(),
    totalCents: bigint("total_cents", { mode: "bigint" }).notNull(),
    note: text("note"),
    /** The customer as at sending, so later edits don't change a sent invoice. */
    billTo: jsonb("bill_to").$type<Invoice["billTo"]>(),
    /** The company as at sending. */
    fromParty: jsonb("from_party").$type<Invoice["from"]>(),
    /**
     * The pay link's capability: 32 random bytes, base64url. Created when the
     * invoice is sent; anyone holding it can view and pay the invoice.
     */
    publicId: text("public_id").unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** When the customer was last emailed the pay link; paces reminders. */
    lastEmailedAt: timestamp("last_emailed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedReason: text("voided_reason"),
    voidedBy: uuid("voided_by").references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "invoices_customer_organization_fk",
      columns: [table.customerId, table.organizationId],
      foreignColumns: [customers.id, customers.organizationId],
    }),
    // Target of the composite foreign keys of line items, payments and
    // invoice payment quotes.
    unique("invoices_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    unique("invoices_organization_number_unique").on(
      table.organizationId,
      table.number,
    ),
    index("invoices_organization_status_due_on_idx").on(
      table.organizationId,
      table.status,
      table.dueOn,
    ),
    index("invoices_customer_id_idx").on(table.customerId),
    check(
      "invoices_amounts",
      sql`${table.subtotalCents} >= 0 AND ${table.taxCents} >= 0 AND ${table.totalCents} = ${table.subtotalCents} + ${table.taxCents}`,
    ),
    check(
      "invoices_tax_rate_bps",
      sql`${table.taxRateBps} IS NULL OR ${table.taxRateBps} BETWEEN 0 AND 10000`,
    ),
    check(
      "invoices_due_not_before_issue",
      sql`${table.dueOn} >= ${table.issueOn}`,
    ),
    // Sending sets all four together; a draft has none.
    check(
      "invoices_sent_has_snapshot",
      sql`(${table.status} = 'draft') = (${table.sentAt} IS NULL) AND (${table.status} = 'draft') = (${table.billTo} IS NULL) AND (${table.status} = 'draft') = (${table.fromParty} IS NULL) AND (${table.status} = 'draft') = (${table.publicId} IS NULL)`,
    ),
    check(
      "invoices_paid_has_time",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "invoices_void_recorded",
      sql`(${table.status} = 'void') = (${table.voidedAt} IS NOT NULL) AND (${table.status} = 'void') = (${table.voidedReason} IS NOT NULL) AND (${table.status} = 'void') = (${table.voidedBy} IS NOT NULL) AND (${table.voidedReason} IS NULL OR length(btrim(${table.voidedReason})) > 0)`,
    ),
  ],
);

/**
 * One line of an invoice. Deleted with its draft, and replaced as a set
 * while the invoice is a draft; a sent invoice's lines never change.
 */
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    invoiceId: uuid("invoice_id").notNull(),
    /** Order on the invoice, from 0. */
    position: integer("position").notNull(),
    description: text("description").notNull(),
    /** Up to three decimals. */
    quantity: numeric("quantity", {
      precision: 15,
      scale: 3,
      mode: "string",
    }).notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "bigint" }).notNull(),
    /** quantity × unit price, rounded half up to the cent, computed by the app. */
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "invoice_line_items_invoice_organization_fk",
      columns: [table.invoiceId, table.organizationId],
      foreignColumns: [invoices.id, invoices.organizationId],
    }).onDelete("cascade"),
    unique("invoice_line_items_invoice_position_unique").on(
      table.invoiceId,
      table.position,
    ),
    check(
      "invoice_line_items_values",
      sql`${table.position} >= 0 AND ${table.quantity} > 0 AND ${table.unitPriceCents} >= 0 AND ${table.amountCents} >= 0`,
    ),
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItemRow = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
