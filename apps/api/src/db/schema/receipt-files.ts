import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { BILL_FILE_ROLES, RECEIPT_FILE_KINDS } from "@expendi-business/shared";

import { bills } from "./bills.js";
import { cardPurchases } from "./cards.js";
import { timestamps } from "./columns.js";
import { expenses } from "./expenses.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const receiptFileKind = pgEnum("receipt_file_kind", RECEIPT_FILE_KINDS);
export const billFileRole = pgEnum("bill_file_role", BILL_FILE_ROLES);

/**
 * A receipt in the company's private R2 folder, or a pasted M-Pesa SMS kept
 * inline (spec §6.3, §10). The row is written when the app asks to upload or
 * pastes the SMS, and stays pending (no expense or bill) until something
 * references it. Its hash stays as the company's duplicate check (spec §6.5).
 */
export const receiptFiles = pgTable(
  "receipt_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    expenseId: uuid("expense_id"),
    /** A bill's attachment (spec §6.20). */
    billId: uuid("bill_id"),
    /**
     * Added to an Expendi card purchase, which may not have its Card expense
     * yet; `expense_id` is set too once it does.
     */
    cardPurchaseId: uuid("card_purchase_id"),
    /** Set with `bill_id`: the invoice, or proof the bill was paid outside Expendi. */
    billRole: billFileRole("bill_role"),
    /** Only the uploader can attach a pending file. */
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    /** `org/<organization id>/receipts/<uuid>.<ext>`; null for an SMS. */
    storageKey: text("storage_key"),
    kind: receiptFileKind("kind").notNull(),
    /**
     * A pasted M-Pesa SMS, whitespace collapsed. A few hundred bytes the API
     * re-reads on every claim write, so it lives here rather than in R2.
     */
    smsText: text("sms_text"),
    /**
     * Lowercase hex SHA-256 of the uploaded bytes, as the app computed it, or
     * of `sms_text` as the API stored it.
     */
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    /**
     * What reading the image returned (spec §6.4), kept so a retry doesn't
     * pay for a second read and copied to the claim's `extraction`.
     */
    extraction: jsonb("extraction"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "receipt_files_expense_organization_fk",
      columns: [table.expenseId, table.organizationId],
      foreignColumns: [expenses.id, expenses.organizationId],
    }),
    foreignKey({
      name: "receipt_files_bill_organization_fk",
      columns: [table.billId, table.organizationId],
      foreignColumns: [bills.id, bills.organizationId],
    }),
    foreignKey({
      name: "receipt_files_card_purchase_organization_fk",
      columns: [table.cardPurchaseId, table.organizationId],
      foreignColumns: [cardPurchases.id, cardPurchases.organizationId],
    }),
    uniqueIndex("receipt_files_sha256_unique").on(
      table.organizationId,
      table.sha256,
    ),
    uniqueIndex("receipt_files_storage_key_unique").on(table.storageKey),
    index("receipt_files_expense_id_idx").on(table.expenseId),
    index("receipt_files_bill_id_idx").on(table.billId),
    index("receipt_files_card_purchase_id_idx").on(table.cardPurchaseId),
    check(
      "receipt_files_one_owner",
      sql`${table.expenseId} IS NULL OR ${table.billId} IS NULL`,
    ),
    check(
      "receipt_files_card_purchase_not_bill",
      sql`${table.cardPurchaseId} IS NULL OR ${table.billId} IS NULL`,
    ),
    check(
      "receipt_files_bill_role",
      sql`(${table.billId} IS NULL) = (${table.billRole} IS NULL)`,
    ),
    // PDFs are bill invoices; claims stay image-only.
    check(
      "receipt_files_pdf_not_on_expense",
      sql`${table.contentType} <> 'application/pdf' OR ${table.expenseId} IS NULL`,
    ),
    check("receipt_files_sha256_hex", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("receipt_files_byte_size_positive", sql`${table.byteSize} > 0`),
    // An SMS is kept inline; every other kind is a file in storage.
    check(
      "receipt_files_sms_inline",
      sql`(${table.kind} = 'sms_text') = (${table.smsText} IS NOT NULL) AND (${table.smsText} IS NULL) = (${table.storageKey} IS NOT NULL)`,
    ),
    // A file can only live in its own company's folder.
    check(
      "receipt_files_key_in_company_folder",
      sql`starts_with(${table.storageKey}, 'org/' || ${table.organizationId}::text || '/')`,
    ),
  ],
);

export type ReceiptFile = typeof receiptFiles.$inferSelect;
export type NewReceiptFile = typeof receiptFiles.$inferInsert;
