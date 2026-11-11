import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { PAYEE_KINDS, PAYEE_METHODS } from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { addressMatchesChain, payeeChain } from "./payee-chain.js";

export const payeeKind = pgEnum("payee_kind", PAYEE_KINDS);
export const payeeMethod = pgEnum("payee_method", PAYEE_METHODS);

/**
 * Anyone the company pays through Expendi other than a staff claim
 * (spec §6.19). `method` is null until payment details are added.
 *
 * - Employee payees are linked to their membership. On `mpesa_phone` they
 *   store no number: they're paid to the one they confirmed by SMS
 *   (`users.phone`, spec §6.18), read when they're paid.
 * - Payment details change only with an admin's passkey, and set
 *   `details_changed_at`: paying within 24 hours of it needs a second
 *   confirmation (spec §7.8).
 */
export const payees = pgTable(
  "payees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: payeeKind("kind").notNull(),
    name: text("name").notNull(),
    membershipId: uuid("membership_id"),
    method: payeeMethod("method"),
    /** E.164 Kenyan mobile; never set for employees. */
    phone: text("phone"),
    tillNumber: text("till_number"),
    paybillNumber: text("paybill_number"),
    /** The account number at the Paybill's business. */
    accountReference: text("account_reference"),
    /** A Paycrest KES institution code. */
    bankCode: text("bank_code"),
    bankAccountNumber: text("bank_account_number"),
    /** The account holder's name, which Paycrest needs for KES payments. */
    accountName: text("account_name"),
    /** The payee chain a USDC payee receives on. */
    usdcChain: payeeChain("usdc_chain"),
    /**
     * On the company's allowlist when it was saved. A Base address is
     * lowercased; a NEAR account or Solana address is kept exactly as given.
     */
    usdcAddress: text("usdc_address"),
    detailsChangedAt: timestamp("details_changed_at", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "payees_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    // Target of bills' composite foreign key.
    unique("payees_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("payees_organization_id_idx").on(table.organizationId),
    uniqueIndex("payees_one_active_per_membership")
      .on(table.organizationId, table.membershipId)
      .where(sql`${table.membershipId} IS NOT NULL AND NOT ${table.archived}`),
    check("payees_name_present", sql`length(btrim(${table.name})) > 0`),
    check(
      "payees_employee_has_membership",
      sql`(${table.kind} = 'employee') = (${table.membershipId} IS NOT NULL)`,
    ),
    check(
      "payees_employee_methods",
      sql`${table.kind} <> 'employee' OR ${table.method} IS NULL OR ${table.method} IN ('mpesa_phone', 'bank', 'outside')`,
    ),
    // Payable details always carry the time they were set.
    check(
      "payees_details_have_changed_at",
      sql`${table.method} IS NULL OR ${table.method} = 'outside' OR ${table.detailsChangedAt} IS NOT NULL`,
    ),
    // One check per method: only that method's fields are set, and the
    // ones it needs are present.
    check(
      "payees_no_details",
      sql`(${table.method} IS NOT NULL AND ${table.method} <> 'outside') OR num_nonnulls(${table.phone}, ${table.tillNumber}, ${table.paybillNumber}, ${table.accountReference}, ${table.bankCode}, ${table.bankAccountNumber}, ${table.accountName}, ${table.usdcAddress}) = 0`,
    ),
    check(
      "payees_mpesa_phone_details",
      sql`${table.method} IS DISTINCT FROM 'mpesa_phone' OR (${table.accountName} IS NOT NULL AND (${table.phone} IS NULL) = (${table.kind} = 'employee') AND (${table.phone} IS NULL OR ${table.phone} ~ '^\\+254[17][0-9]{8}$') AND num_nonnulls(${table.tillNumber}, ${table.paybillNumber}, ${table.accountReference}, ${table.bankCode}, ${table.bankAccountNumber}, ${table.usdcAddress}) = 0)`,
    ),
    check(
      "payees_mpesa_till_details",
      sql`${table.method} IS DISTINCT FROM 'mpesa_till' OR (${table.accountName} IS NOT NULL AND ${table.tillNumber} IS NOT NULL AND ${table.tillNumber} ~ '^[0-9]{5,7}$' AND num_nonnulls(${table.phone}, ${table.paybillNumber}, ${table.accountReference}, ${table.bankCode}, ${table.bankAccountNumber}, ${table.usdcAddress}) = 0)`,
    ),
    check(
      "payees_mpesa_paybill_details",
      sql`${table.method} IS DISTINCT FROM 'mpesa_paybill' OR (${table.accountName} IS NOT NULL AND ${table.paybillNumber} IS NOT NULL AND ${table.paybillNumber} ~ '^[0-9]{5,7}$' AND ${table.accountReference} IS NOT NULL AND num_nonnulls(${table.phone}, ${table.tillNumber}, ${table.bankCode}, ${table.bankAccountNumber}, ${table.usdcAddress}) = 0)`,
    ),
    check(
      "payees_bank_details",
      sql`${table.method} IS DISTINCT FROM 'bank' OR (${table.accountName} IS NOT NULL AND ${table.bankCode} IS NOT NULL AND ${table.bankAccountNumber} IS NOT NULL AND num_nonnulls(${table.phone}, ${table.tillNumber}, ${table.paybillNumber}, ${table.accountReference}, ${table.usdcAddress}) = 0)`,
    ),
    check(
      "payees_usdc_details",
      sql`${table.method} IS DISTINCT FROM 'usdc' OR (${table.usdcAddress} IS NOT NULL AND num_nonnulls(${table.phone}, ${table.tillNumber}, ${table.paybillNumber}, ${table.accountReference}, ${table.bankCode}, ${table.bankAccountNumber}, ${table.accountName}) = 0)`,
    ),
    // An address always says which chain it is on, so the other methods'
    // checks, which rule out an address, rule out a chain too.
    check(
      "payees_usdc_chain_with_address",
      sql`(${table.usdcChain} IS NULL) = (${table.usdcAddress} IS NULL)`,
    ),
    check(
      "payees_usdc_address_matches_chain",
      sql`${table.usdcAddress} IS NULL OR ${addressMatchesChain(table.usdcChain, table.usdcAddress)}`,
    ),
  ],
);

export type PayeeRow = typeof payees.$inferSelect;
export type NewPayee = typeof payees.$inferInsert;
