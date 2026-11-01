import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { WALLET_CHAINS } from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

export const walletChain = pgEnum("wallet_chain", WALLET_CHAINS);

/**
 * `creating` until both the Privy policy and the wallet exist. Creation
 * resumes from whichever step a crash or retry stopped at.
 */
export const walletStatus = pgEnum("wallet_status", ["creating", "active"]);

/**
 * One USDC wallet per company, never pooled (spec §7.1). Owned in Privy by
 * Expendi's management key; the API signs as an additional signer bound by
 * the wallet's policy (docs/decisions/privy-wallet-policies.md).
 */
export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    chain: walletChain("chain").notNull().default("base"),
    status: walletStatus("status").notNull().default("creating"),
    /** The policy's per-transaction cap, in USDC base units. */
    perTransactionMaxUsdc: bigint("per_transaction_max_usdc", {
      mode: "bigint",
    }).notNull(),
    privyPolicyId: text("privy_policy_id"),
    privyWalletId: text("privy_wallet_id"),
    /** EIP-55 checksummed, as Privy returns it. */
    address: text("address"),
    /** When the Alchemy deposit webhook started watching the address. */
    depositsWatchedAt: timestamp("deposits_watched_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("wallets_organization_id_unique").on(table.organizationId),
    // Target of wallet_transactions' composite foreign key.
    unique("wallets_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("wallets_privy_wallet_id_unique").on(table.privyWalletId),
    uniqueIndex("wallets_address_unique").on(sql`lower(${table.address})`),
    check(
      "wallets_active_is_complete",
      sql`${table.status} <> 'active' OR (${table.privyPolicyId} IS NOT NULL AND ${table.privyWalletId} IS NOT NULL AND ${table.address} IS NOT NULL)`,
    ),
    check(
      "wallets_per_transaction_max_positive",
      sql`${table.perTransactionMaxUsdc} > 0`,
    ),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
