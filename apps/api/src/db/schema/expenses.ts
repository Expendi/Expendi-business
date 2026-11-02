import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ETIMS_STATUSES,
  EXPENSE_KINDS,
  EXPENSE_SOURCES,
  EXPENSE_STATUSES,
  OVERVIEW_HEADINGS,
} from "@expendi-business/shared";

import { categories } from "./categories.js";
import { timestamps } from "./columns.js";
import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const expenseKind = pgEnum("expense_kind", EXPENSE_KINDS);
export const overviewHeading = pgEnum("overview_heading", OVERVIEW_HEADINGS);
export const expenseSource = pgEnum("expense_source", EXPENSE_SOURCES);
export const expenseStatus = pgEnum("expense_status", EXPENSE_STATUSES);
export const etimsStatus = pgEnum("etims_status", ETIMS_STATUSES);

/**
 * Money out recorded with a receipt (spec §5, §10): staff claims now, float
 * and company spending in Phase 2B. The duplicate rules (spec §6.5) apply to
 * every kind, so the M-Pesa code and eTIMS invoice number are unique per
 * company whatever the kind.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** The claimant, the float holder, or the admin who recorded company spending. */
    membershipId: uuid("membership_id").notNull(),
    kind: expenseKind("kind").notNull(),
    overviewHeading: overviewHeading("overview_heading").notNull(),
    /** Float spending's float (spec §6.22); its foreign key comes with the floats table. */
    floatId: uuid("float_id"),
    /** Company spending's source account, as mapped for Zoho (spec §6.23). */
    paidFromAccount: text("paid_from_account"),
    categoryId: uuid("category_id").notNull(),
    merchant: text("merchant").notNull(),
    /** KES cents. */
    amountKes: bigint("amount_kes", { mode: "bigint" }).notNull(),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    /** Null only for imported history. */
    description: text("description"),
    source: expenseSource("source").notNull().default("app"),
    status: expenseStatus("status").notNull(),
    /** Uppercase, e.g. SLK4H7Q2XY. */
    mpesaCode: text("mpesa_code"),
    /** Uppercase. */
    etimsInvoiceNumber: text("etims_invoice_number"),
    etimsSupplierPin: text("etims_supplier_pin"),
    /** The eTIMS QR code exactly as scanned (spec §6.4). */
    etimsQrPayload: text("etims_qr_payload"),
    etimsStatus: etimsStatus("etims_status").notNull().default("none"),
    /** What reading the receipt returned, before the employee's edits (spec §6.4). */
    extraction: jsonb("extraction"),
    /** Shown to the admin, e.g. a near-duplicate or an old date (spec §6.5). */
    warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
    /** Set only while `rejected`; earlier reasons stay in the audit log. */
    rejectedReason: text("rejected_reason"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "expenses_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    foreignKey({
      name: "expenses_category_organization_fk",
      columns: [table.categoryId, table.organizationId],
      foreignColumns: [categories.id, categories.organizationId],
    }),
    // Target of receipt_files' composite foreign key.
    unique("expenses_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("expenses_mpesa_code_unique")
      .on(table.organizationId, table.mpesaCode)
      .where(sql`${table.mpesaCode} IS NOT NULL`),
    uniqueIndex("expenses_etims_invoice_number_unique")
      .on(table.organizationId, table.etimsInvoiceNumber)
      .where(sql`${table.etimsInvoiceNumber} IS NOT NULL`),
    index("expenses_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("expenses_membership_created_idx").on(
      table.membershipId,
      table.createdAt,
    ),
    check("expenses_amount_positive", sql`${table.amountKes} > 0`),
    check(
      "expenses_codes_uppercase",
      sql`${table.mpesaCode} = upper(${table.mpesaCode}) AND ${table.etimsInvoiceNumber} = upper(${table.etimsInvoiceNumber})`,
    ),
    check(
      "expenses_rejected_has_reason",
      sql`(${table.status} = 'rejected') = (${table.rejectedReason} IS NOT NULL)`,
    ),
  ],
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
