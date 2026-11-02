import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  RECURRING_PAY_VIA,
  RECURRING_SCHEDULES,
  REMINDER_DAYS_DEFAULT,
  REMINDER_DAYS_MAX,
} from "@expendi-business/shared";

import { categories } from "./categories.js";
import { timestamps } from "./columns.js";
import { billCurrency } from "./currency.js";
import { organizations } from "./organizations.js";
import { overviewHeading } from "./overview-heading.js";
import { payees } from "./payees.js";

export const recurringSchedule = pgEnum(
  "recurring_schedule",
  RECURRING_SCHEDULES,
);
export const recurringPayVia = pgEnum("recurring_pay_via", RECURRING_PAY_VIA);

/**
 * A payment set up once that falls due on a schedule (spec §6.20, §10).
 * Admins only (spec §4), down to row-level security, like bills.
 *
 * - `schedule_day` is the ISO weekday (1 is Monday) for weekly, the day of
 *   the month otherwise; quarterly and yearly count from `starts_on`'s
 *   month. A day past a month's end falls on its last day.
 * - `next_due_on` is the due date of the next bill the schedule creates. It
 *   never passes `ends_on`; null means the schedule has ended, which is
 *   final. `active = false` is paused.
 * - Salaries (the `salaries` heading) are created and billed by payroll
 *   (T38), not by the recurring-bills job: monthly on the pay day, a fixed
 *   net pay, paid through Expendi. `next_due_on` is the next pay date not
 *   yet in a payroll run.
 */
export const recurringItems = pgTable(
  "recurring_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    payeeId: uuid("payee_id").notNull(),
    overviewHeading: overviewHeading("overview_heading").notNull(),
    categoryId: uuid("category_id").notNull(),
    /** KES, or USD for a payee paid in USDC (spec §6.19); its bills take it. */
    currency: billCurrency("currency").notNull().default("kes"),
    /** KES cents for every bill; null when variable, entered on each bill. */
    amountKes: bigint("amount_kes", { mode: "bigint" }),
    /** A USD item's amount for every bill: USDC base units (6 decimals). */
    amountUsdc: bigint("amount_usdc", { mode: "bigint" }),
    schedule: recurringSchedule("schedule").notNull(),
    scheduleDay: integer("schedule_day").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    payVia: recurringPayVia("pay_via").notNull().default("expendi"),
    reminderDays: integer("reminder_days")
      .notNull()
      .default(REMINDER_DAYS_DEFAULT),
    active: boolean("active").notNull().default(true),
    nextDueOn: date("next_due_on", { mode: "string" }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "recurring_items_payee_organization_fk",
      columns: [table.payeeId, table.organizationId],
      foreignColumns: [payees.id, payees.organizationId],
    }),
    foreignKey({
      name: "recurring_items_category_organization_fk",
      columns: [table.categoryId, table.organizationId],
      foreignColumns: [categories.id, categories.organizationId],
    }),
    // Target of bills' composite foreign key.
    unique("recurring_items_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("recurring_items_organization_id_idx").on(table.organizationId),
    index("recurring_items_payee_id_idx").on(table.payeeId),
    // What the daily recurring-bills job scans.
    index("recurring_items_scheduled_idx")
      .on(table.nextDueOn)
      .where(sql`${table.active} AND ${table.nextDueOn} IS NOT NULL`),
    check(
      "recurring_items_heading",
      sql`${table.overviewHeading} IN ('transactions', 'subscriptions', 'salaries')`,
    ),
    check(
      "recurring_items_amount_positive",
      sql`${table.amountKes} IS NULL OR ${table.amountKes} > 0`,
    ),
    check(
      "recurring_items_amount_usdc_positive",
      sql`${table.amountUsdc} IS NULL OR ${table.amountUsdc} > 0`,
    ),
    check(
      "recurring_items_amount_in_currency",
      sql`(${table.currency} = 'kes' AND ${table.amountUsdc} IS NULL) OR (${table.currency} = 'usd' AND ${table.amountKes} IS NULL)`,
    ),
    check(
      "recurring_items_schedule_day",
      sql`${table.scheduleDay} >= 1 AND ${table.scheduleDay} <= CASE WHEN ${table.schedule} = 'weekly' THEN 7 ELSE 31 END`,
    ),
    check(
      "recurring_items_reminder_days",
      sql`${table.reminderDays} BETWEEN 0 AND ${sql.raw(String(REMINDER_DAYS_MAX))}`,
    ),
    check(
      "recurring_items_ends_after_start",
      sql`${table.endsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`,
    ),
    // A person has one salary until it ends.
    uniqueIndex("recurring_items_one_salary_per_payee")
      .on(table.payeeId)
      .where(
        sql`${table.overviewHeading} = 'salaries' AND ${table.nextDueOn} IS NOT NULL`,
      ),
    check(
      "recurring_items_salary_shape",
      sql`${table.overviewHeading} <> 'salaries' OR (${table.amountKes} IS NOT NULL AND ${table.currency} = 'kes' AND ${table.schedule} = 'monthly' AND ${table.payVia} = 'expendi')`,
    ),
    check(
      "recurring_items_next_due_in_schedule",
      sql`${table.nextDueOn} IS NULL OR (${table.nextDueOn} >= ${table.startsOn} AND (${table.endsOn} IS NULL OR ${table.nextDueOn} <= ${table.endsOn}))`,
    ),
  ],
);

export type RecurringItemRow = typeof recurringItems.$inferSelect;
export type NewRecurringItem = typeof recurringItems.$inferInsert;
