import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

/**
 * A company's expense categories (spec §6.1). A new company gets the starter
 * list, which admins can edit. Archiving hides a category from new spending
 * but keeps it on old records, so a name only has to be unique, ignoring
 * case, among the company's categories that aren't archived.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** No eTIMS invoice is expected, e.g. air tickets (spec §6.6). */
    etimsNotRequired: boolean("etims_not_required").notNull().default(false),
    /** The Zoho Books expense account it maps to (spec §6.17). */
    accountingAccountId: text("accounting_account_id"),
    archived: boolean("archived").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("categories_active_name_unique")
      .on(table.organizationId, sql`lower(${table.name})`)
      .where(sql`NOT ${table.archived}`),
    // Target of expenses' composite foreign key.
    unique("categories_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
