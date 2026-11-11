import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { wallets } from "./wallets.js";

/**
 * - `transfer`, `transfer_call`: USDC on NEAR, from the company wallet.
 * - `intents_transfer`: a token the company holds inside NEAR Intents, to
 *   another account there (`mt_transfer` on the NEAR Intents contract).
 */
export const COMPANY_WALLET_SEND_KINDS = [
  "transfer",
  "transfer_call",
  "intents_transfer",
] as const;
export type CompanyWalletSendKind = (typeof COMPANY_WALLET_SEND_KINDS)[number];

/**
 * - `reserved`: holds the wallet's next nonce; nothing is signed yet.
 * - `signed`: the signed delegate action is saved and may have been relayed.
 * - `executed`: the chain ran it and the USDC moved. Final.
 * - `failed`: the chain ran it but the USDC call failed, so nothing moved. Final.
 * - `expired`: its expiry passed and the chain shows it never ran. Final.
 * - `refused`: the cap or Privy refused it, so nothing was signed. Final.
 */
export const COMPANY_WALLET_SEND_STATUSES = [
  "reserved",
  "signed",
  "executed",
  "failed",
  "expired",
  "refused",
] as const;
export type CompanyWalletSendStatus =
  (typeof COMPANY_WALLET_SEND_STATUSES)[number];

export const companyWalletSendKind = pgEnum(
  "company_wallet_send_kind",
  COMPANY_WALLET_SEND_KINDS,
);

export const companyWalletSendStatus = pgEnum(
  "company_wallet_send_status",
  COMPANY_WALLET_SEND_STATUSES,
);

/**
 * Every USDC send a company wallet has signed, saved before it is relayed
 * (docs/decisions/near-main-chain.md, "Sending from a company wallet").
 * The API broadcasts NEAR sends itself, so this row, not Privy, is what
 * makes a retry safe: it relays the same bytes again, and the nonce in
 * them lets the chain run them once at most.
 */
export const companyWalletSends = pgTable(
  "company_wallet_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    walletId: uuid("wallet_id").notNull(),
    /** Names what the send is for, e.g. one payout: the same key never sends twice. */
    sendKey: text("send_key").notNull(),
    kind: companyWalletSendKind("kind").notNull(),
    status: companyWalletSendStatus("status").notNull().default("reserved"),
    /** The company wallet's account when the send was built. */
    senderAccountId: text("sender_account_id").notNull(),
    receiverAccountId: text("receiver_account_id").notNull(),
    /**
     * USDC base units; for `intents_transfer`, base units of `tokenId`, which
     * is always a USDC with 6 decimals, so the cap reads the same.
     */
    usdcAmount: bigint("usdc_amount", { mode: "bigint" }).notNull(),
    /** `intents_transfer` only: the NEAR Intents token ID, e.g. `nep141:…`. */
    tokenId: text("token_id"),
    /** The `msg` of an `ft_transfer_call`. */
    msg: text("msg"),
    /** The delegate action's nonce on the company wallet's access key. */
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    /** The last block the chain will run the delegate action in. */
    maxBlockHeight: bigint("max_block_height", { mode: "bigint" }).notNull(),
    /** The borsh-encoded signed delegate action, base64. */
    signedDelegate: text("signed_delegate"),
    /**
     * The relayer transactions that carried it, each saved before it was
     * broadcast. NEAR hashes are base58 and case-sensitive.
     */
    relayTxHashes: text("relay_tx_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The relayer transaction the chain ran it in. */
    txHash: text("tx_hash"),
    blockHeight: bigint("block_height", { mode: "bigint" }),
    /** Why it was refused, failed or expired, for whoever reviews it. */
    failure: text("failure"),
    ...timestamps,
  },
  (table) => [
    // The wallet must belong to the same company as the send.
    foreignKey({
      name: "company_wallet_sends_wallet_organization_fk",
      columns: [table.walletId, table.organizationId],
      foreignColumns: [wallets.id, wallets.organizationId],
    }),
    // Target of intent_quotes' composite foreign key.
    unique("company_wallet_sends_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    // A new send for the same key may be built only once the last one is
    // known never to have moved anything and never will.
    uniqueIndex("company_wallet_sends_live_key_unique")
      .on(table.organizationId, table.sendKey)
      .where(
        sql`${table.status} IN ('reserved', 'signed', 'executed', 'failed')`,
      ),
    // One send in flight per wallet: with two, the one the chain ran second
    // could overtake the first's nonce, and whether the first ran could no
    // longer be read from the wallet's nonce alone.
    uniqueIndex("company_wallet_sends_one_in_flight_per_wallet")
      .on(table.walletId)
      .where(sql`${table.status} IN ('reserved', 'signed')`),
    uniqueIndex("company_wallet_sends_wallet_nonce_unique").on(
      table.walletId,
      table.nonce,
    ),
    check("company_wallet_sends_amount_positive", sql`${table.usdcAmount} > 0`),
    check(
      "company_wallet_sends_msg_matches_kind",
      sql`(${table.kind} = 'transfer_call') = (${table.msg} IS NOT NULL)`,
    ),
    // Compared as text: an enum value can't be used in the transaction that
    // adds it.
    check(
      "company_wallet_sends_token_matches_kind",
      sql`(${table.kind}::text = 'intents_transfer') = (${table.tokenId} IS NOT NULL)`,
    ),
    check(
      "company_wallet_sends_signed_is_saved",
      sql`${table.status} NOT IN ('signed', 'executed', 'failed') OR ${table.signedDelegate} IS NOT NULL`,
    ),
    check(
      "company_wallet_sends_ran_has_transaction",
      sql`${table.status} NOT IN ('executed', 'failed') OR (${table.txHash} IS NOT NULL AND ${table.blockHeight} IS NOT NULL)`,
    ),
  ],
);

export type CompanyWalletSend = typeof companyWalletSends.$inferSelect;
export type NewCompanyWalletSend = typeof companyWalletSends.$inferInsert;
