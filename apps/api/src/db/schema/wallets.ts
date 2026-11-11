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

import {
  MAIN_CHAIN,
  WALLET_CHAINS,
  WALLET_STATUSES,
} from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

export const walletChain = pgEnum("wallet_chain", WALLET_CHAINS);

/**
 * `creating` until the company wallet and its transit wallet both exist and
 * the company wallet's account is usable on chain. Creation resumes from
 * whichever step a crash or retry stopped at.
 */
export const walletStatus = pgEnum("wallet_status", WALLET_STATUSES);

/**
 * One company wallet per company, never pooled (spec §7.1), with the transit
 * wallet that goes with it (docs/decisions/near-main-chain.md). Both are
 * owned in Privy by Expendi's management key, and the API signs as an
 * additional signer.
 *
 * A `base` row is a wallet made before NEAR became the main chain: its
 * `privyWalletId` and `address` are on Base and it has no transit wallet.
 */
export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /**
     * Set by the API, not by a column default: Postgres can't use a new enum
     * value as a default in the migration that adds it.
     */
    chain: walletChain("chain")
      .notNull()
      .$default(() => MAIN_CHAIN),
    status: walletStatus("status").notNull().default("creating"),
    /**
     * The most USDC one transaction may move, in base units. Privy enforces
     * it on the transit wallet through its policy; on the company wallet,
     * where Privy has no policies, the API enforces it before signing.
     */
    perTransactionMaxUsdc: bigint("per_transaction_max_usdc", {
      mode: "bigint",
    }).notNull(),
    /** The company wallet in Privy. */
    privyWalletId: text("privy_wallet_id"),
    /**
     * The company wallet's account ID: on NEAR, the 64-hex implicit account
     * Privy returns as the wallet's address.
     */
    address: text("address"),
    /** The transit wallet's Privy policy (USDC on Base only, capped). */
    privyPolicyId: text("privy_policy_id"),
    transitPrivyWalletId: text("transit_privy_wallet_id"),
    /** The transit wallet on Base, EIP-55 checksummed as Privy returns it. */
    transitAddress: text("transit_address"),
    /**
     * When the gas relayer had created the company wallet's account on chain
     * and registered it with the USDC contract.
     */
    onchainActivatedAt: timestamp("onchain_activated_at", {
      withTimezone: true,
    }),
    /**
     * When the Alchemy webhook started watching the wallet's Base address:
     * the transit address, or `address` for a `base` row.
     */
    depositsWatchedAt: timestamp("deposits_watched_at", { withTimezone: true }),
    /**
     * Where the deposit watcher resumes reading the company wallet's
     * transfers: the token the transfers API gave with the last page it
     * finished. Null until the first page is done.
     */
    depositsResumeToken: text("deposits_resume_token"),
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
    uniqueIndex("wallets_transit_privy_wallet_id_unique").on(
      table.transitPrivyWalletId,
    ),
    uniqueIndex("wallets_transit_address_unique").on(
      sql`lower(${table.transitAddress})`,
    ),
    // Rule 4 of the decision record. Rows made before the move keep the
    // rule they were created under.
    check(
      "wallets_active_is_complete",
      sql`${table.status} <> 'active' OR (${table.privyPolicyId} IS NOT NULL AND ${table.privyWalletId} IS NOT NULL AND ${table.address} IS NOT NULL AND (${table.chain} = 'base' OR (${table.transitPrivyWalletId} IS NOT NULL AND ${table.transitAddress} IS NOT NULL AND ${table.onchainActivatedAt} IS NOT NULL)))`,
    ),
    check(
      "wallets_per_transaction_max_positive",
      sql`${table.perTransactionMaxUsdc} > 0`,
    ),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
