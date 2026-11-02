import type {
  BillHeading,
  CreateRecurringItemRequest,
  RecurringItem,
  RecurringItemState,
  RecurringPayVia,
  RecurringSchedule,
  UpdateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  describeSchedule,
  parseKesToCents,
  REMINDER_DAYS_DEFAULT,
} from "@expendi-business/shared";

import { blankToNull, centsToTyped } from "../bills/bill-draft";

/** The recurring payment form as typed; the API parses the amount into integer cents. */
export interface RecurringDraft {
  payeeId: string | null;
  variable: boolean;
  amount: string;
  schedule: RecurringSchedule;
  /** The ISO weekday for weekly (1 is Monday), the day of the month otherwise. */
  scheduleDay: string;
  startsOn: string;
  /** Blank for no end date. */
  endsOn: string;
  payVia: RecurringPayVia;
  reminderDays: string;
  /** Null follows the payee: Subscriptions for a subscription vendor. */
  heading: BillHeading | null;
  categoryId: string | null;
}

export const STATE_LABELS: Record<
  RecurringItemState,
  { label: string; tone: "neutral" | "success" | "warning" }
> = {
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  ended: { label: "Ended", tone: "neutral" },
};

/** ISO weekday of a `YYYY-MM-DD` date, 1 for Monday to 7 for Sunday. */
export function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return ((day + 6) % 7) + 1;
}

/** A new payment: monthly, starting today, on today's day of the month. */
export function blankDraft(today: string): RecurringDraft {
  return {
    payeeId: null,
    variable: false,
    amount: "",
    schedule: "monthly",
    scheduleDay: String(Number(today.slice(8, 10))),
    startsOn: today,
    endsOn: "",
    payVia: "expendi",
    reminderDays: String(REMINDER_DAYS_DEFAULT),
    heading: null,
    categoryId: null,
  };
}

/** The day that fits a schedule picked after the start date: its weekday, or its day of the month. */
export function defaultScheduleDay(
  schedule: RecurringSchedule,
  startsOn: string,
): string {
  return schedule === "weekly"
    ? String(isoWeekday(startsOn))
    : String(Number(startsOn.slice(8, 10)));
}

const wholeNumber = (typed: string): number =>
  /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : Number.NaN;

export function toCreateRequest(
  draft: RecurringDraft,
): CreateRecurringItemRequest {
  return {
    payeeId: draft.payeeId ?? "",
    variable: draft.variable,
    amountKes: draft.variable ? null : blankToNull(draft.amount),
    schedule: draft.schedule,
    scheduleDay: wholeNumber(draft.scheduleDay),
    startsOn: draft.startsOn.trim(),
    endsOn: blankToNull(draft.endsOn)?.trim() ?? null,
    payVia: draft.payVia,
    reminderDays: wholeNumber(draft.reminderDays),
    overviewHeading: draft.heading ?? undefined,
    categoryId: draft.categoryId ?? "",
  };
}

export function draftFromItem(item: RecurringItem): RecurringDraft {
  return {
    payeeId: item.payee.id,
    variable: item.variable,
    amount: item.amountKes === null ? "" : centsToTyped(item.amountKes),
    schedule: item.schedule,
    scheduleDay: String(item.scheduleDay),
    startsOn: item.startsOn,
    endsOn: item.endsOn ?? "",
    payVia: item.payVia,
    reminderDays: String(item.reminderDays),
    heading:
      item.overviewHeading === "transactions" ||
      item.overviewHeading === "subscriptions"
        ? item.overviewHeading
        : null,
    categoryId: item.category.id,
  };
}

/** Only the fields that changed; an empty request changes nothing. */
export function toUpdateRequest(
  item: RecurringItem,
  draft: RecurringDraft,
): UpdateRecurringItemRequest {
  const request: UpdateRecurringItemRequest = {};
  const typedAmount = draft.variable ? null : draft.amount.trim();
  const typedCents =
    typedAmount === null
      ? null
      : (parseKesToCents(typedAmount)?.toString() ?? typedAmount);
  if (typedCents !== item.amountKes) request.amountKes = typedAmount;
  if (draft.categoryId !== null && draft.categoryId !== item.category.id) {
    request.categoryId = draft.categoryId;
  }
  if (draft.heading !== null && draft.heading !== item.overviewHeading) {
    request.overviewHeading = draft.heading;
  }
  const reminderDays = wholeNumber(draft.reminderDays);
  if (reminderDays !== item.reminderDays) request.reminderDays = reminderDays;
  const endsOn = blankToNull(draft.endsOn)?.trim() ?? null;
  if (endsOn !== item.endsOn) request.endsOn = endsOn;
  return request;
}

/** What's due next: the bill still owed, or else the next one the schedule will create. */
export function nextDueDate(item: RecurringItem): string | null {
  return item.nextBill?.dueOn ?? item.nextDueOn;
}

export function scheduleInWords(
  item: Pick<RecurringItem, "schedule" | "scheduleDay" | "startsOn">,
): string {
  return describeSchedule(item.schedule, item.scheduleDay, item.startsOn);
}
