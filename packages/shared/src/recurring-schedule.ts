import { z } from "zod";

/**
 * A recurring payment's schedule and state, apart from `recurring.ts` so
 * `bills.ts` can describe a bill's recurring payment without importing it
 * back.
 */

/** How often a recurring payment falls due (spec §6.20). */
export const RECURRING_SCHEDULES = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;
export const recurringScheduleSchema = z.enum(RECURRING_SCHEDULES, {
  error: "Pick weekly, monthly, quarterly or yearly.",
});
export type RecurringSchedule = z.infer<typeof recurringScheduleSchema>;

/**
 * `active` creates bills; `paused` stops until resumed, keeping its bills;
 * `ended` has no bills left to create, because its end date passed or an
 * admin ended it. Ending is final.
 */
export const RECURRING_ITEM_STATES = ["active", "paused", "ended"] as const;
export type RecurringItemState = (typeof RECURRING_ITEM_STATES)[number];
