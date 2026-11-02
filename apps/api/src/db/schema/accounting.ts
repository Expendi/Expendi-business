import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ACCOUNTING_CONNECTION_STATUSES,
  ACCOUNTING_PROVIDERS,
  ACCOUNTING_SYNC_STATUSES,
  ACCOUNTING_SYNC_SUBJECT_TYPES,
} from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";

export const accountingProvider = pgEnum(
  "accounting_provider",
  ACCOUNTING_PROVIDERS,
);
export const accountingConnectionStatus = pgEnum(
  "accounting_connection_status",
  ACCOUNTING_CONNECTION_STATUSES,
);
export const accountingSyncSubjectType = pgEnum(
  "accounting_sync_subject_type",
  ACCOUNTING_SYNC_SUBJECT_TYPES,
);
export const accountingSyncStatus = pgEnum(
  "accounting_sync_status",
  ACCOUNTING_SYNC_STATUSES,
);

/**
 * A company's link to its accounting system (spec §6.17). A company has at
 * most one connection that isn't `disconnected`; disconnecting keeps the row
 * for history and a new connect link starts a new one.
 *
 * - The connect link's token is stored only as its SHA-256 hex hash. It's
 *   spent (`connect_token_used_at`) when the Zoho sign-in completes; the
 *   hash stays so a second use is refused as used rather than unknown.
 * - `refresh_token_encrypted` is AES-256-GCM (`services/zoho/token-crypto.ts`)
 *   and never leaves the API. It's cleared on disconnect and when Zoho
 *   rejects it.
 * - `accounts_server` and `api_domain` are the Zoho data centre the person
 *   signed in on; every later call goes there.
 * - The category mapping is `categories.accounting_account_id`.
 */
export const accountingConnections = pgTable(
  "accounting_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: accountingProvider("provider").notNull().default("zoho_books"),
    externalOrganizationId: text("external_organization_id"),
    /** Zoho's name for it when it was chosen, for the admin app. */
    externalOrganizationName: text("external_organization_name"),
    accountsServer: text("accounts_server"),
    apiDomain: text("api_domain"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    paidThroughAccountId: text("paid_through_account_id"),
    defaultAccountId: text("default_account_id"),
    pettyCashAccountId: text("petty_cash_account_id"),
    salariesAccountId: text("salaries_account_id"),
    status: accountingConnectionStatus("status").notNull().default("pending"),
    connectTokenHash: text("connect_token_hash"),
    connectTokenExpiresAt: timestamp("connect_token_expires_at", {
      withTimezone: true,
    }),
    connectTokenUsedAt: timestamp("connect_token_used_at", {
      withTimezone: true,
    }),
    /** When someone last finished the Zoho sign-in. */
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("accounting_connections_one_open_per_organization")
      .on(table.organizationId)
      .where(sql`${table.status} <> 'disconnected'`),
    uniqueIndex("accounting_connections_connect_token_hash_unique").on(
      table.connectTokenHash,
    ),
    check(
      "accounting_connections_connect_token_complete",
      sql`(${table.connectTokenHash} IS NULL) = (${table.connectTokenExpiresAt} IS NULL)`,
    ),
    check(
      "accounting_connections_signed_in_complete",
      sql`${table.refreshTokenEncrypted} IS NULL OR (${table.accountsServer} IS NOT NULL AND ${table.apiDomain} IS NOT NULL AND ${table.connectedAt} IS NOT NULL)`,
    ),
    check(
      "accounting_connections_active_ready",
      sql`${table.status} <> 'active' OR (${table.refreshTokenEncrypted} IS NOT NULL AND ${table.externalOrganizationId} IS NOT NULL)`,
    ),
    check(
      "accounting_connections_disconnected_holds_nothing",
      sql`${table.status} <> 'disconnected' OR (${table.refreshTokenEncrypted} IS NULL AND ${table.connectTokenHash} IS NULL)`,
    ),
  ],
);

export type AccountingConnectionRow = typeof accountingConnections.$inferSelect;

/**
 * One paid item's push to the accounting system (spec §6.17). Created by
 * T31's sync; at most one per item, so a retry never posts twice.
 */
export const accountingSyncs = pgTable(
  "accounting_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    subjectType: accountingSyncSubjectType("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    provider: accountingProvider("provider").notNull().default("zoho_books"),
    /** The accounting system's ID for what was created, e.g. Zoho's expense_id. */
    externalId: text("external_id"),
    /** Bound before the first provider call; never reuse an ID in a different ledger. */
    externalOrganizationId: text("external_organization_id"),
    status: accountingSyncStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    receiptAttached: boolean("receipt_attached").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("accounting_syncs_subject_unique").on(
      table.organizationId,
      table.subjectType,
      table.subjectId,
    ),
    check(
      "accounting_syncs_attempts_non_negative",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "accounting_syncs_synced_complete",
      sql`${table.status} <> 'synced' OR (${table.externalId} IS NOT NULL AND ${table.syncedAt} IS NOT NULL)`,
    ),
  ],
);

export type AccountingSyncRow = typeof accountingSyncs.$inferSelect;
