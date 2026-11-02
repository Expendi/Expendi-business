import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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

import { BILL_STATUSES } from "@expendi-business/shared";

import { categories } from "./categories.js";
import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { overviewHeading } from "./overview-heading.js";
import { payees } from "./payees.js";
import { payouts } from "./payouts.js";
import { payrollRuns } from "./payroll-runs.js";
import { recurringItems } from "./recurring-items.js";
import { users } from "./users.js";

export const billStatus = pgEnum("bill_status", BILL_STATUSES);

/**
 * Money the company owes a payee by a due date (spec §6.20, §10). Admins
 * only (spec §4), down to row-level security.
 *
 * - `upcoming`, `due` and `overdue` follow `due_on` against today in
 *   Nairobi: set when the bill is saved, then moved forward by the daily
 *   job (`advance_bill_statuses`), which never touches any other status.
 * - A variable bill (e.g. PAYE) has no amount until the admin enters it,
 *   and can't be paid or marked paid before then.
 * - `paid_on` is the Kenyan calendar day the money went out; `paid_at` is
 *   when Expendi recorded it.
 */
export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    payeeId: uuid("payee_id").notNull(),
    /** The recurring payment that created it (T36). */
    recurringItemId: uuid("recurring_item_id"),
    /** Salary bills only (T38). */
    payrollRunId: uuid("payroll_run_id"),
    overviewHeading: overviewHeading("overview_heading").notNull(),
    categoryId: uuid("category_id").notNull(),
    variable: boolean("variable").notNull().default(false),
    /** KES cents; null on a variable bill until its amount is entered. */
    amountKes: bigint("amount_kes", { mode: "bigint" }),
    /** e.g. an invoice number or a KRA payment registration number. */
    reference: text("reference"),
    notes: text("notes"),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    status: billStatus("status").notNull(),
    /** Why a fixed amount last changed; earlier reasons stay in the audit log. */
    adjustmentReason: text("adjustment_reason"),
    paidOn: date("paid_on", { mode: "string" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    markedPaidBy: uuid("marked_paid_by").references(() => users.id),
    paidOutsideNote: text("paid_outside_note"),
    cancelledReason: text("cancelled_reason"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** The latest payout paying it through Expendi (T37). */
    payoutId: uuid("payout_id"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "bills_payee_organization_fk",
      columns: [table.payeeId, table.organizationId],
      foreignColumns: [payees.id, payees.organizationId],
    }),
    foreignKey({
      name: "bills_category_organization_fk",
      columns: [table.categoryId, table.organizationId],
      foreignColumns: [categories.id, categories.organizationId],
    }),
    foreignKey({
      name: "bills_recurring_item_organization_fk",
      columns: [table.recurringItemId, table.organizationId],
      foreignColumns: [recurringItems.id, recurringItems.organizationId],
    }),
    foreignKey({
      name: "bills_payroll_run_organization_fk",
      columns: [table.payrollRunId, table.organizationId],
      foreignColumns: [payrollRuns.id, payrollRuns.organizationId],
    }),
    foreignKey({
      name: "bills_payout_organization_fk",
      columns: [table.payoutId, table.organizationId],
      foreignColumns: [payouts.id, payouts.organizationId],
    }),
    // Target of receipt_files' composite foreign key.
    unique("bills_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("bills_payout_id_unique")
      .on(table.payoutId)
      .where(sql`${table.payoutId} IS NOT NULL`),
    index("bills_organization_due_on_idx").on(
      table.organizationId,
      table.dueOn,
    ),
    index("bills_payee_id_idx").on(table.payeeId),
    // A recurring payment has at most one bill still owed (spec §10): one
    // unpaid, or being paid. Its next bill can only be created once that one
    // is paid, paid outside or cancelled. OUTSTANDING_BILL_STATUSES in shared.
    // Salaries are left out: their unit is the payroll run, so a person's
    // pay for one month never waits on the month before, e.g. a failed
    // payout still being retried.
    uniqueIndex("bills_recurring_item_outstanding_unique")
      .on(table.recurringItemId)
      .where(
        sql`${table.recurringItemId} IS NOT NULL AND ${table.payrollRunId} IS NULL AND ${table.status} IN ('upcoming', 'due', 'overdue', 'payout_failed', 'paying')`,
      ),
    // One bill per salary in a payroll run, whatever its status: a person
    // left out of a run isn't drafted into it again. One-off payments have
    // no salary, so a person can have several.
    uniqueIndex("bills_payroll_run_salary_unique")
      .on(table.payrollRunId, table.recurringItemId)
      .where(
        sql`${table.payrollRunId} IS NOT NULL AND ${table.recurringItemId} IS NOT NULL`,
      ),
    index("bills_payroll_run_id_idx")
      .on(table.payrollRunId)
      .where(sql`${table.payrollRunId} IS NOT NULL`),
    // What the daily status job scans.
    index("bills_dated_due_on_idx")
      .on(table.dueOn)
      .where(sql`${table.status} IN ('upcoming', 'due')`),
    check(
      "bills_heading",
      sql`${table.overviewHeading} <> 'petty_cash' AND (${table.payrollRunId} IS NULL OR ${table.overviewHeading} = 'salaries')`,
    ),
    check(
      "bills_amount_positive",
      sql`${table.amountKes} IS NULL OR ${table.amountKes} > 0`,
    ),
    check(
      "bills_fixed_has_amount",
      sql`${table.variable} OR ${table.amountKes} IS NOT NULL`,
    ),
    check(
      "bills_settled_has_amount",
      sql`${table.status} NOT IN ('paying', 'paid', 'paid_outside') OR ${table.amountKes} IS NOT NULL`,
    ),
    check(
      "bills_paid_has_dates",
      sql`(${table.status} IN ('paid', 'paid_outside')) = (${table.paidOn} IS NOT NULL) AND (${table.status} IN ('paid', 'paid_outside')) = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "bills_paid_outside_recorded",
      sql`(${table.status} = 'paid_outside') = (${table.markedPaidBy} IS NOT NULL) AND (${table.paidOutsideNote} IS NULL OR ${table.status} = 'paid_outside')`,
    ),
    check(
      "bills_cancelled_recorded",
      sql`(${table.status} = 'cancelled') = (${table.cancelledReason} IS NOT NULL) AND (${table.status} = 'cancelled') = (${table.cancelledBy} IS NOT NULL) AND (${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL) AND (${table.cancelledReason} IS NULL OR length(btrim(${table.cancelledReason})) > 0)`,
    ),
    check(
      "bills_through_expendi_has_payout",
      sql`${table.status} NOT IN ('paying', 'paid', 'payout_failed') OR ${table.payoutId} IS NOT NULL`,
    ),
  ],
);

export type BillRow = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;
