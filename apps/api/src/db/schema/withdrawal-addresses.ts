import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { addressMatchesChain, payeeChain } from "./payee-chain.js";
import { users } from "./users.js";

/**
 * The company's allowlist of addresses, each on its payee chain (spec §6.9,
 * §6.19, §7): the only places USDC payees and withdrawals can be paid. Adding or removing
 * one needs an admin's passkey. Removal is a soft delete, so history stays.
 */
export const withdrawalAddresses = pgTable(
  "withdrawal_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    chain: payeeChain("chain").notNull(),
    /**
     * A Base address is lowercased, so one address is listed once however
     * it was typed. A NEAR account is lowercase by rule, and a Solana
     * address is case-sensitive: neither is ever changed.
     */
    address: text("address").notNull(),
    label: text("label").notNull(),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    /** When the admin's passkey confirmed the addition. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    removedBy: uuid("removed_by").references(() => users.id),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("withdrawal_addresses_active_unique")
      .on(table.organizationId, table.chain, table.address)
      .where(sql`${table.removedAt} IS NULL`),
    index("withdrawal_addresses_organization_id_idx").on(table.organizationId),
    check(
      "withdrawal_addresses_address_matches_chain",
      addressMatchesChain(table.chain, table.address),
    ),
  ],
);

export type WithdrawalAddress = typeof withdrawalAddresses.$inferSelect;
