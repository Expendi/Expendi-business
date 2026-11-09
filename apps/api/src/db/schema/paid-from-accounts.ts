import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { PAID_FROM_ACCOUNT_KINDS } from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

export const paidFromAccountKind = pgEnum(
  "paid_from_account_kind",
  PAID_FROM_ACCOUNT_KINDS,
);

/**
 * A company's own list of the accounts it pays from outside Expendi, e.g.
 * its bank account or a bank card (spec §6.23). Company
 * spending names the one it came from, and the accountant maps each to a
 * Zoho Books Paid Through account (spec §6.17, T44). Archiving hides an
 * account from new spending but keeps it on old records, so a name only has
 * to be unique, ignoring case, among the accounts still in use.
 */
export const paidFromAccounts = pgTable(
  "paid_from_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    kind: paidFromAccountKind("kind").notNull(),
    /** The Zoho Books Paid Through account it maps to (T44). */
    accountingAccountId: text("accounting_account_id"),
    archived: boolean("archived").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    // Target of expenses' composite foreign key.
    unique("paid_from_accounts_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("paid_from_accounts_active_name_unique")
      .on(table.organizationId, sql`lower(${table.name})`)
      .where(sql`NOT ${table.archived}`),
    check(
      "paid_from_accounts_name_present",
      sql`length(btrim(${table.name})) > 0`,
    ),
  ],
);

export type PaidFromAccountRow = typeof paidFromAccounts.$inferSelect;
export type NewPaidFromAccount = typeof paidFromAccounts.$inferInsert;
