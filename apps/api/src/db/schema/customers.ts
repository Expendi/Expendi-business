import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

/**
 * Who a company invoices (docs/decisions/crypto-invoicing.md). Not a payee:
 * a payee is someone the company pays. Admins write them; accountants read
 * them.
 *
 * Archived, never deleted, so an invoice always has its customer; the app
 * role has no DELETE on this table. Editing a customer applies to future
 * invoices only: a sent invoice keeps the snapshot taken when it was sent.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** Where invoices and receipts are emailed. */
    email: text("email").notNull(),
    address: text("address"),
    /** A KRA PIN for a Kenyan customer. */
    taxId: text("tax_id"),
    /** Hidden from the customer picker once set; invoices keep pointing here. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Target of invoices' composite foreign key.
    unique("customers_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("customers_organization_name_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
