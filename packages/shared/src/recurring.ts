import { z } from "zod";

import type { BillStatus } from "./bills.js";
import type { OverviewHeading } from "./claims.js";
import type { RecurringSchedule } from "./recurring-schedule.js";
import {
  billCurrencySchema,
  billHeadingSchema,
  billStatusSchema,
  UNPAID_BILL_STATUSES,
  usdAmountSchema,
} from "./bills.js";
import { kesAmountSchema } from "./claims.js";
import { payeeKindSchema, payeeMethodSchema } from "./payee.js";
import {
  RECURRING_ITEM_STATES,
  recurringScheduleSchema,
} from "./recurring-schedule.js";

export {
  RECURRING_ITEM_STATES,
  RECURRING_SCHEDULES,
  recurringScheduleSchema,
} from "./recurring-schedule.js";
export type {
  RecurringItemState,
  RecurringSchedule,
} from "./recurring-schedule.js";

/**
 * Paid through Expendi, or outside it (e.g. a card-only subscription),
 * where the admin marks each bill paid.
 */
export const RECURRING_PAY_VIA = ["expendi", "outside"] as const;
export const recurringPayViaSchema = z.enum(RECURRING_PAY_VIA, {
  error: "Pick through Expendi or outside Expendi.",
});
export type RecurringPayVia = z.infer<typeof recurringPayViaSchema>;

/**
 * Where a recurring payment sits in the overview. Salaries are recurring
 * payments under the Salaries heading, set up and paid through payroll
 * (T38); the rest create bills.
 */
export const RECURRING_HEADINGS = [
  "transactions",
  "subscriptions",
  "salaries",
] as const satisfies readonly OverviewHeading[];
export type RecurringHeading = (typeof RECURRING_HEADINGS)[number];

/**
 * A bill that is still owed: unpaid, or being paid. A recurring payment
 * has at most one at a time, so a payment in flight holds its place.
 */
export const OUTSTANDING_BILL_STATUSES = [
  ...UNPAID_BILL_STATUSES,
  "paying",
] as const satisfies readonly BillStatus[];

export const REMINDER_DAYS_DEFAULT = 3;
export const REMINDER_DAYS_MAX = 30;
export const RECURRING_ITEMS_LIST_MAX_SIZE = 500;

/**
 * `GET …/recurring-items` filters. Salaries are listed unless
 * `excludeSalaries=true`: the Bills page leaves them to Payroll.
 */
export const listRecurringItemsQuerySchema = z.object({
  excludeSalaries: z
    .enum(["true", "false"], { error: "excludeSalaries is true or false." })
    .transform((value) => value === "true")
    .optional(),
});

export type ListRecurringItemsQuery = z.input<
  typeof listRecurringItemsQuerySchema
>;

/** ISO weekdays: 1 is Monday, 7 is Sunday. */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** The most a schedule day can be: a weekday for weekly, a day of the month otherwise. */
export function maxScheduleDay(schedule: RecurringSchedule): number {
  return schedule === "weekly" ? 7 : 31;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** `startsOn`'s month, 0 for January. Quarterly and yearly schedules count from it. */
function startMonth(startsOn: string): number {
  return Number(startsOn.slice(5, 7)) - 1;
}

const monthName = (month: number): string => MONTH_NAMES[month % 12] ?? "";

/** The longest the month ever is, counting leap years. */
const longestMonth = (month: number): number =>
  [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 31;

/**
 * The schedule in words, e.g. "Monthly on the 31st, or the month's last
 * day". A day past a month's end falls on its last day.
 */
export function describeSchedule(
  schedule: RecurringSchedule,
  scheduleDay: number,
  startsOn: string,
): string {
  const lastDayNote = scheduleDay > 28 ? ", or the month’s last day" : "";
  switch (schedule) {
    case "weekly":
      return `Every ${WEEKDAY_NAMES[scheduleDay - 1] ?? "week"}`;
    case "monthly":
      return `Monthly on the ${ordinal(scheduleDay)}${lastDayNote}`;
    case "quarterly": {
      const first = startMonth(startsOn);
      const months = [0, 3, 6, 9]
        .map((offset) => (first + offset) % 12)
        .sort((a, b) => a - b)
        .map((month) => monthName(month).slice(0, 3));
      return `Quarterly on the ${ordinal(scheduleDay)} of ${months.slice(0, 3).join(", ")} and ${months[3] ?? ""}${lastDayNote}`;
    }
    case "yearly": {
      const month = startMonth(startsOn);
      if (month === 1 && scheduleDay >= 29) {
        return "Yearly on the last day of February";
      }
      const day = Math.min(scheduleDay, longestMonth(month));
      return `Yearly on ${day} ${monthName(month)}`;
    }
  }
}

const isoDate = (missing: string) => z.iso.date({ error: missing });

const reminderDaysSchema = z
  .int({ error: "Enter the reminder lead time in whole days." })
  .min(0, "The reminder can't be after the due date.")
  .max(
    REMINDER_DAYS_MAX,
    `Remind at most ${REMINDER_DAYS_MAX} days before the due date.`,
  );

/**
 * A recurring payment (spec §6.20). A fixed one has an amount; a variable
 * one (e.g. PAYE or electricity) has none, and each bill's amount is
 * entered before it's paid. `scheduleDay` is the ISO weekday (1 is Monday)
 * for weekly, the day of the month otherwise. Quarterly and yearly count
 * from `startsOn`'s month. The heading defaults from the payee. The amount
 * is in USD (`amountUsd`) when the payee is paid in USDC (spec §6.19).
 */
export const createRecurringItemRequestSchema = z
  .object({
    payeeId: z.uuid({ error: "Pick who it's paid to." }),
    variable: z.boolean().default(false),
    amountKes: kesAmountSchema.nullish(),
    amountUsd: usdAmountSchema.nullish(),
    schedule: recurringScheduleSchema,
    scheduleDay: z.int({ error: "Pick the day it falls due." }).min(1),
    startsOn: isoDate("Enter the start date as YYYY-MM-DD."),
    endsOn: isoDate("Enter the end date as YYYY-MM-DD.").nullish(),
    payVia: recurringPayViaSchema.default("expendi"),
    reminderDays: reminderDaysSchema.default(REMINDER_DAYS_DEFAULT),
    overviewHeading: billHeadingSchema.optional(),
    categoryId: z.uuid({ error: "Pick a category." }),
  })
  .superRefine((item, ctx) => {
    const hasAmount = item.amountKes != null || item.amountUsd != null;
    if (item.amountKes != null && item.amountUsd != null) {
      ctx.addIssue({
        code: "custom",
        message: "Enter the amount in KES or in USD, not both.",
        path: ["amountUsd"],
      });
    }
    if (item.variable && hasAmount) {
      ctx.addIssue({
        code: "custom",
        message: "A variable payment has no set amount.",
        path: ["amountKes"],
      });
    }
    if (!item.variable && !hasAmount) {
      ctx.addIssue({
        code: "custom",
        message: "Enter the amount, or mark the payment as variable.",
        path: ["amountKes"],
      });
    }
    if (item.scheduleDay > maxScheduleDay(item.schedule)) {
      ctx.addIssue({
        code: "custom",
        message:
          item.schedule === "weekly"
            ? "Pick a weekday, 1 (Monday) to 7 (Sunday)."
            : "Pick a day of the month, 1 to 31.",
        path: ["scheduleDay"],
      });
    }
    if (item.endsOn != null && item.endsOn < item.startsOn) {
      ctx.addIssue({
        code: "custom",
        message: "The end date can't be before the start date.",
        path: ["endsOn"],
      });
    }
  });

export type CreateRecurringItemRequest = z.input<
  typeof createRecurringItemRequestSchema
>;
export type CreateRecurringItemFields = z.output<
  typeof createRecurringItemRequestSchema
>;

/**
 * Changes for the bills still to come; the current bill keeps its amount
 * unless it's changed on the bill. A field left out is unchanged. A null
 * amount makes the payment variable; a null end date removes it. The
 * amount goes in `amountUsd` when the payee is paid in USDC.
 */
export const updateRecurringItemRequestSchema = z
  .object({
    amountKes: kesAmountSchema.nullable().optional(),
    amountUsd: usdAmountSchema.nullable().optional(),
    categoryId: z.uuid({ error: "Pick a category." }).optional(),
    overviewHeading: billHeadingSchema.optional(),
    reminderDays: reminderDaysSchema.optional(),
    endsOn: isoDate("Enter the end date as YYYY-MM-DD.").nullable().optional(),
  })
  .refine(
    (item) => item.amountKes === undefined || item.amountUsd === undefined,
    {
      message: "Enter the amount in KES or in USD, not both.",
      path: ["amountUsd"],
    },
  );

export type UpdateRecurringItemRequest = z.input<
  typeof updateRecurringItemRequestSchema
>;
export type UpdateRecurringItemFields = z.output<
  typeof updateRecurringItemRequestSchema
>;

export const recurringItemSchema = z.object({
  id: z.uuid(),
  state: z.enum(RECURRING_ITEM_STATES),
  payee: z.object({
    id: z.uuid(),
    name: z.string(),
    kind: payeeKindSchema,
    method: payeeMethodSchema.nullable(),
    archived: z.boolean(),
  }),
  overviewHeading: z.enum(RECURRING_HEADINGS),
  category: z.object({ id: z.uuid(), name: z.string() }),
  variable: z.boolean(),
  /** USD for a payee paid in USDC; every bill takes it. */
  currency: billCurrencySchema,
  /** KES cents as a decimal string; null when variable or in USD. */
  amountKes: z.string().regex(/^\d+$/).nullable(),
  /** USDC base units as a decimal string; null when variable or in KES. */
  amountUsdc: z.string().regex(/^\d+$/).nullable(),
  schedule: recurringScheduleSchema,
  scheduleDay: z.int(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  payVia: recurringPayViaSchema,
  reminderDays: z.int(),
  /** False while paused. */
  active: z.boolean(),
  /**
   * The due date of the next bill the schedule will create, after
   * `nextBill` is settled; null once it has ended.
   */
  nextDueOn: z.iso.date().nullable(),
  /** The bill still owed, if any: unpaid, or being paid. */
  nextBill: z
    .object({
      id: z.uuid(),
      status: billStatusSchema,
      dueOn: z.iso.date(),
      /**
       * The bill's own currency: the item's, unless the payee's method
       * changed since the bill was created. Always sent; optional only for
       * clients built before it.
       */
      currency: billCurrencySchema.optional(),
      amountKes: z.string().regex(/^\d+$/).nullable(),
      amountUsdc: z.string().regex(/^\d+$/).nullable(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type RecurringItem = z.infer<typeof recurringItemSchema>;

export const recurringItemsResponseSchema = z.array(recurringItemSchema);

export type RecurringItemsResponse = z.infer<
  typeof recurringItemsResponseSchema
>;
