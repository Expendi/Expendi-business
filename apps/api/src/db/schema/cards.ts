import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
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
  CARD_PURCHASE_KINDS,
  CARD_PURCHASE_STATUSES,
  CARD_STATES,
} from "@expendi-business/shared";

import { categories } from "./categories.js";
import { timestamps } from "./columns.js";
import { expenses } from "./expenses.js";
import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { paidFromAccounts } from "./paid-from-accounts.js";
import { users } from "./users.js";

export const cardState = pgEnum("card_state", CARD_STATES);
export const cardPurchaseKind = pgEnum(
  "card_purchase_kind",
  CARD_PURCHASE_KINDS,
);
export const cardPurchaseStatus = pgEnum(
  "card_purchase_status",
  CARD_PURCHASE_STATUSES,
);

/**
 * A company's "Turn on cards" details and its business at Lithic (spec
 * §6.25). `paid_from_account_id` is the account the accountant maps to Zoho
 * for all of the company's Card expenses.
 */
export const cardPrograms = pgTable(
  "card_programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    legalName: text("legal_name").notNull(),
    kraPin: text("kra_pin").notNull(),
    addressLine1: text("address_line1").notNull(),
    city: text("city").notNull(),
    postalCode: text("postal_code").notNull(),
    phone: text("phone").notNull(),
    contactFirstName: text("contact_first_name").notNull(),
    contactLastName: text("contact_last_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone").notNull(),
    lithicAccountHolderToken: text("lithic_account_holder_token").notNull(),
    lithicAccountToken: text("lithic_account_token").notNull(),
    paidFromAccountId: uuid("paid_from_account_id").notNull(),
    turnedOnBy: uuid("turned_on_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("card_programs_organization_unique").on(table.organizationId),
    foreignKey({
      name: "card_programs_paid_from_account_organization_fk",
      columns: [table.paidFromAccountId, table.organizationId],
      foreignColumns: [paidFromAccounts.id, paidFromAccounts.organizationId],
    }),
  ],
);

/** A member as Lithic knows them: an authorized user of the company's business. */
export const cardholders = pgTable(
  "cardholders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    membershipId: uuid("membership_id").notNull(),
    lithicAccountHolderToken: text("lithic_account_holder_token").notNull(),
    lithicAccountToken: text("lithic_account_token").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "cardholders_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    uniqueIndex("cardholders_membership_unique").on(table.membershipId),
    unique("cardholders_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
  ],
);

/**
 * An Expendi card. The number and CVV are never stored: only Lithic's embed
 * shows them. `close_requested_at` is set in the transaction that removes a
 * member, so a card is closed at Lithic even if the first attempt fails.
 */
export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    cardholderId: uuid("cardholder_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    lithicCardToken: text("lithic_card_token").notNull(),
    nickname: text("nickname").notNull(),
    lastFour: text("last_four").notNull(),
    state: cardState("state").notNull().default("open"),
    /** US cents; Lithic enforces it per calendar month. */
    monthlyLimitUsdCents: bigint("monthly_limit_usd_cents", {
      mode: "bigint",
    }).notNull(),
    defaultCategoryId: uuid("default_category_id").notNull(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    closeRequestedAt: timestamp("close_requested_at", { withTimezone: true }),
    closeAttempts: integer("close_attempts").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "cards_cardholder_organization_fk",
      columns: [table.cardholderId, table.organizationId],
      foreignColumns: [cardholders.id, cardholders.organizationId],
    }),
    foreignKey({
      name: "cards_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    foreignKey({
      name: "cards_default_category_organization_fk",
      columns: [table.defaultCategoryId, table.organizationId],
      foreignColumns: [categories.id, categories.organizationId],
    }),
    unique("cards_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("cards_lithic_card_token_unique").on(table.lithicCardToken),
    index("cards_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("cards_membership_idx").on(table.membershipId),
    index("cards_close_requested_idx")
      .on(table.closeRequestedAt)
      .where(
        sql`${table.closeRequestedAt} IS NOT NULL AND ${table.state} <> 'closed'`,
      ),
    check(
      "cards_monthly_limit_positive",
      sql`${table.monthlyLimitUsdCents} > 0`,
    ),
    check(
      "cards_closed_has_date",
      sql`(${table.state} = 'closed') = (${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * A Card load: money set aside from the wallet for the company's cards. In
 * the sandbox it's only this row: no USDC moves, and the wallet ledger is
 * never touched.
 */
export const cardLoads = pgTable(
  "card_loads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    amountUsdCents: bigint("amount_usd_cents", { mode: "bigint" }).notNull(),
    /** What it counted for against the daily cap, in KES cents. */
    amountKes: bigint("amount_kes", { mode: "bigint" }).notNull(),
    usdKesRate: text("usd_kes_rate").notNull(),
    simulated: boolean("simulated").notNull().default(true),
    loadedBy: uuid("loaded_by")
      .notNull()
      .references(() => users.id),
    approvalId: uuid("approval_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("card_loads_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check("card_loads_amount_positive", sql`${table.amountUsdCents} > 0`),
    check("card_loads_kes_positive", sql`${table.amountKes} > 0`),
    check("card_loads_simulated", sql`${table.simulated}`),
  ],
);

/**
 * One Lithic transaction on an Expendi card, updated from its current state
 * however often Lithic tells us about it. A `refund` is its own row: Lithic
 * says most can't be tied to the original purchase.
 */
export const cardPurchases = pgTable(
  "card_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    cardId: uuid("card_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    lithicTransactionToken: text("lithic_transaction_token").notNull(),
    kind: cardPurchaseKind("kind").notNull().default("purchase"),
    status: cardPurchaseStatus("status").notNull(),
    merchant: text("merchant").notNull(),
    mcc: text("mcc").notNull(),
    merchantCity: text("merchant_city"),
    merchantCountry: text("merchant_country"),
    /** US cents still held, as a positive number. */
    holdUsdCents: bigint("hold_usd_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** US cents settled, as a positive number, for a spend or a refund. */
    settledUsdCents: bigint("settled_usd_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    declineReason: text("decline_reason"),
    /** The Card expense's category; starts as the card's default. */
    categoryId: uuid("category_id").notNull(),
    /** Set with `expense_id`: the Paycrest rate its KES amount used. */
    usdKesRate: text("usd_kes_rate"),
    expenseId: uuid("expense_id"),
    /** Its amounts moved after the Card expense was recorded. */
    changedAfterExpenseAt: timestamp("changed_after_expense_at", {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "card_purchases_card_organization_fk",
      columns: [table.cardId, table.organizationId],
      foreignColumns: [cards.id, cards.organizationId],
    }),
    foreignKey({
      name: "card_purchases_membership_organization_fk",
      columns: [table.membershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    foreignKey({
      name: "card_purchases_category_organization_fk",
      columns: [table.categoryId, table.organizationId],
      foreignColumns: [categories.id, categories.organizationId],
    }),
    foreignKey({
      name: "card_purchases_expense_organization_fk",
      columns: [table.expenseId, table.organizationId],
      foreignColumns: [expenses.id, expenses.organizationId],
    }),
    unique("card_purchases_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("card_purchases_transaction_token_unique").on(
      table.lithicTransactionToken,
    ),
    uniqueIndex("card_purchases_expense_unique")
      .on(table.expenseId)
      .where(sql`${table.expenseId} IS NOT NULL`),
    index("card_purchases_organization_authorized_idx").on(
      table.organizationId,
      table.authorizedAt,
    ),
    index("card_purchases_card_authorized_idx").on(
      table.cardId,
      table.authorizedAt,
    ),
    index("card_purchases_membership_authorized_idx").on(
      table.membershipId,
      table.authorizedAt,
    ),
    index("card_purchases_unfinished_idx")
      .on(table.updatedAt)
      .where(
        sql`${table.status} = 'pending' OR ${table.holdUsdCents} > 0 OR (${table.kind} = 'purchase' AND ${table.status} = 'settled' AND ${table.expenseId} IS NULL)`,
      ),
    check("card_purchases_hold_not_negative", sql`${table.holdUsdCents} >= 0`),
    check(
      "card_purchases_settled_not_negative",
      sql`${table.settledUsdCents} >= 0`,
    ),
    check(
      "card_purchases_refund_settled",
      sql`${table.kind} <> 'refund' OR ${table.status} = 'settled'`,
    ),
    check(
      "card_purchases_expense_has_rate",
      sql`(${table.expenseId} IS NULL) = (${table.usdKesRate} IS NULL)`,
    ),
  ],
);

export type CardProgram = typeof cardPrograms.$inferSelect;
export type Cardholder = typeof cardholders.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type CardLoad = typeof cardLoads.$inferSelect;
export type CardPurchase = typeof cardPurchases.$inferSelect;
