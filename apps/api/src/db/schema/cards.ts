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
  CARD_PURCHASE_REVIEW_STATES,
  CARD_PURCHASE_STATUSES,
  CARD_STATES,
} from "@expendi-business/shared";

import { bills } from "./bills.js";
import { categories } from "./categories.js";
import { timestamps } from "./columns.js";
import { expenses } from "./expenses.js";
import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { paidFromAccounts } from "./paid-from-accounts.js";
import { recurringItems } from "./recurring-items.js";
import { staffUsers } from "./staff-users.js";
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
export const cardPurchaseReviewState = pgEnum(
  "card_purchase_review_state",
  CARD_PURCHASE_REVIEW_STATES,
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
 *
 * A company-held card has no cardholder: it's issued on the company's own
 * account at Lithic, so nobody leaving closes it, and only it can pay a
 * recurring payment (spec §6.20).
 */
export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    companyHeld: boolean("company_held").notNull().default(false),
    /** Null exactly when company-held, like `membership_id`. */
    cardholderId: uuid("cardholder_id"),
    membershipId: uuid("membership_id"),
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
    check(
      "cards_holder_unless_company_held",
      sql`${table.companyHeld} = (${table.cardholderId} IS NULL) AND ${table.companyHeld} = (${table.membershipId} IS NULL)`,
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
 *
 * On a company-held card (`membership_id` null) a purchase either belongs to
 * one of the card's recurring payments, and pays its bill once settled, or
 * has a `review_state` from an admin's answer about its merchant.
 */
export const cardPurchases = pgTable(
  "card_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    cardId: uuid("card_id").notNull(),
    /** The cardholder's; null on a company-held card. */
    membershipId: uuid("membership_id"),
    lithicTransactionToken: text("lithic_transaction_token").notNull(),
    kind: cardPurchaseKind("kind").notNull().default("purchase"),
    status: cardPurchaseStatus("status").notNull(),
    merchant: text("merchant").notNull(),
    /** Lithic's ID for the merchant, once it has charged; the descriptor can change. */
    merchantKey: text("merchant_key"),
    /** The company-held card's recurring payment it belongs to. */
    recurringItemId: uuid("recurring_item_id"),
    /** The bill it paid, once settled; that bill is `paid_by_card`. */
    billId: uuid("bill_id"),
    reviewState: cardPurchaseReviewState("review_state"),
    /** The admin who answered for its merchant, and when. */
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
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
    foreignKey({
      name: "card_purchases_recurring_item_organization_fk",
      columns: [table.recurringItemId, table.organizationId],
      foreignColumns: [recurringItems.id, recurringItems.organizationId],
    }),
    foreignKey({
      name: "card_purchases_bill_organization_fk",
      columns: [table.billId, table.organizationId],
      foreignColumns: [bills.id, bills.organizationId],
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
    // A bill is paid by one Card purchase at most.
    uniqueIndex("card_purchases_bill_unique")
      .on(table.billId)
      .where(sql`${table.billId} IS NOT NULL`),
    // Admins' "needs an answer" list.
    index("card_purchases_needs_review_idx")
      .on(table.organizationId, table.authorizedAt)
      .where(sql`${table.reviewState} = 'needs_review'`),
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
    // Only a company-held card pays recurring payments or asks about merchants.
    check(
      "card_purchases_match_on_company_held",
      sql`${table.membershipId} IS NULL OR (${table.recurringItemId} IS NULL AND ${table.billId} IS NULL AND ${table.reviewState} IS NULL)`,
    ),
    // Linked to a recurring payment, or reviewed as something else, never both.
    check(
      "card_purchases_linked_or_reviewed",
      sql`${table.recurringItemId} IS NULL OR ${table.reviewState} IS NULL`,
    ),
    check(
      "card_purchases_bill_is_linked",
      sql`${table.billId} IS NULL OR ${table.recurringItemId} IS NOT NULL`,
    ),
    check(
      "card_purchases_reviewed_recorded",
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`,
    ),
  ],
);

/**
 * The merchants a company-held card has seen, by Lithic's merchant ID. A
 * merchant is linked to one of the card's recurring payments, blocked after
 * an admin didn't recognise it, or neither: a one-off, or still waiting for
 * an admin's answer.
 */
export const cardMerchants = pgTable(
  "card_merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    cardId: uuid("card_id").notNull(),
    merchantKey: text("merchant_key").notNull(),
    /** The descriptor it first charged under, for people to read. */
    descriptor: text("descriptor").notNull(),
    recurringItemId: uuid("recurring_item_id"),
    blocked: boolean("blocked").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "card_merchants_card_organization_fk",
      columns: [table.cardId, table.organizationId],
      foreignColumns: [cards.id, cards.organizationId],
    }),
    foreignKey({
      name: "card_merchants_recurring_item_organization_fk",
      columns: [table.recurringItemId, table.organizationId],
      foreignColumns: [recurringItems.id, recurringItems.organizationId],
    }),
    uniqueIndex("card_merchants_card_merchant_unique").on(
      table.cardId,
      table.merchantKey,
    ),
    index("card_merchants_recurring_item_idx")
      .on(table.recurringItemId)
      .where(sql`${table.recurringItemId} IS NOT NULL`),
    check(
      "card_merchants_blocked_unlinked",
      sql`NOT (${table.blocked} AND ${table.recurringItemId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Sandbox only: the pretend merchant purchases made on company-held cards,
 * by the daily job (`run_by_staff` null) or by Expendi staff from ops
 * admin, so the job never makes two for one bill. Append-only; it goes when
 * real merchants charge real cards.
 */
export const cardSimulations = pgTable(
  "card_simulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    recurringItemId: uuid("recurring_item_id").notNull(),
    /** The bill it was made for; null when staff ran it with none open. */
    billId: uuid("bill_id"),
    lithicTransactionToken: text("lithic_transaction_token").notNull(),
    amountUsdCents: bigint("amount_usd_cents", { mode: "bigint" }).notNull(),
    merchantKey: text("merchant_key").notNull(),
    runByStaff: uuid("run_by_staff").references(() => staffUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "card_simulations_recurring_item_organization_fk",
      columns: [table.recurringItemId, table.organizationId],
      foreignColumns: [recurringItems.id, recurringItems.organizationId],
    }),
    foreignKey({
      name: "card_simulations_bill_organization_fk",
      columns: [table.billId, table.organizationId],
      foreignColumns: [bills.id, bills.organizationId],
    }),
    uniqueIndex("card_simulations_transaction_token_unique").on(
      table.lithicTransactionToken,
    ),
    index("card_simulations_bill_idx").on(table.billId),
    check("card_simulations_amount_positive", sql`${table.amountUsdCents} > 0`),
  ],
);

export type CardProgram = typeof cardPrograms.$inferSelect;
export type Cardholder = typeof cardholders.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type CardLoad = typeof cardLoads.$inferSelect;
export type CardPurchase = typeof cardPurchases.$inferSelect;
export type CardMerchant = typeof cardMerchants.$inferSelect;
export type CardSimulation = typeof cardSimulations.$inferSelect;
