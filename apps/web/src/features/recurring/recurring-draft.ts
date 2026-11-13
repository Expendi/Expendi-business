import type {
  BillCurrency,
  BillHeading,
  CreateRecurringItemRequest,
  PayeeMethod,
  RecurringItem,
  RecurringItemState,
  RecurringPayVia,
  RecurringSchedule,
  UpdateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  CARD_LIMIT_HEADROOM_PERCENT,
  describeSchedule,
  REMINDER_DAYS_DEFAULT,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import {
  currencyOfPayee,
  parseTyped,
  storedAmount,
  toTyped,
} from "~/features/bills/bill-amount";
import { blankToNull } from "~/features/bills/bill-draft";

/** The recurring payment form as typed; the API parses the amount into integer cents. */
export interface RecurringDraft {
  payeeId: string | null;
  variable: boolean;
  /** USD for a payee paid in USDC (spec §6.19), KES otherwise. */
  currency: BillCurrency;
  amount: string;
  schedule: RecurringSchedule;
  /** The ISO weekday for weekly (1 is Monday), the day of the month otherwise. */
  scheduleDay: string;
  startsOn: string;
  /** Blank for no end date. */
  endsOn: string;
  payVia: RecurringPayVia;
  /** The company-held card that pays it, while `payVia` is `card`. */
  cardId: string | null;
  reminderDays: string;
  /** Null follows the payee: Subscriptions for a subscription vendor. */
  heading: BillHeading | null;
  categoryId: string | null;
}

export const STATE_LABELS: Record<
  RecurringItemState,
  { label: string; tone: StatusTone }
> = {
  active: { label: "Active", tone: "paid" },
  paused: { label: "Paused", tone: "waiting" },
  ended: { label: "Ended", tone: "rejected" },
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
    currency: "kes",
    amount: "",
    schedule: "monthly",
    scheduleDay: String(Number(today.slice(8, 10))),
    startsOn: today,
    endsOn: "",
    payVia: "expendi",
    cardId: null,
    reminderDays: String(REMINDER_DAYS_DEFAULT),
    heading: null,
    categoryId: null,
  };
}

/**
 * A payment by company-held card has an optional USD estimate in place of
 * an amount (spec §6.20): left blank, it's variable.
 */
function amountOfDraft(draft: RecurringDraft): {
  readonly variable: boolean;
  readonly typed: string | null;
} {
  if (draft.payVia === "card") {
    const typed = blankToNull(draft.amount)?.trim() ?? null;
    return { variable: typed === null, typed };
  }
  return {
    variable: draft.variable,
    typed: draft.variable ? null : draft.amount.trim(),
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
  const common = {
    payeeId: draft.payeeId ?? "",
    schedule: draft.schedule,
    scheduleDay: wholeNumber(draft.scheduleDay),
    startsOn: draft.startsOn.trim(),
    endsOn: blankToNull(draft.endsOn)?.trim() ?? null,
    reminderDays: wholeNumber(draft.reminderDays),
    overviewHeading: draft.heading ?? undefined,
    categoryId: draft.categoryId ?? "",
  };
  if (draft.payVia === "card") {
    const { variable, typed } = amountOfDraft(draft);
    return {
      ...common,
      variable,
      amountUsd: typed,
      payVia: "card",
      cardId: draft.cardId,
    };
  }
  return {
    ...common,
    variable: draft.variable,
    ...(draft.currency === "usd"
      ? { amountUsd: draft.variable ? null : blankToNull(draft.amount) }
      : { amountKes: draft.variable ? null : blankToNull(draft.amount) }),
    payVia: draft.payVia,
  };
}

/**
 * The payment as its form starts, its amount in the payee's currency as it
 * is now: blank if their method moved between KES and USDC since.
 */
export function draftFromItem(item: RecurringItem): RecurringDraft {
  const currency = draftCurrency(item.payVia, item.payee.method, item.currency);
  const stored = currency === item.currency ? storedAmount(item) : null;
  return {
    payeeId: item.payee.id,
    variable: item.variable,
    currency,
    amount: stored === null ? "" : toTyped(currency, stored),
    schedule: item.schedule,
    scheduleDay: String(item.scheduleDay),
    startsOn: item.startsOn,
    endsOn: item.endsOn ?? "",
    payVia: item.payVia,
    cardId: item.payVia === "card" ? (item.card?.id ?? null) : null,
    reminderDays: String(item.reminderDays),
    heading:
      item.overviewHeading === "transactions" ||
      item.overviewHeading === "subscriptions"
        ? item.overviewHeading
        : null,
    categoryId: item.category.id,
  };
}

/**
 * The currency a payment's amount is typed in: USD by company-held card,
 * whoever the payee is (spec §6.20), else the payee's.
 */
export function draftCurrency(
  payVia: RecurringPayVia,
  method: PayeeMethod | null | undefined,
  fallback: BillCurrency,
): BillCurrency {
  return payVia === "card" ? "usd" : currencyOfPayee(method, fallback);
}

/** What was typed for one way of paying: its amount (by card, the estimate) and its card. */
type PayViaEntry = Pick<RecurringDraft, "currency" | "amount" | "cardId">;

export type PayViaMemory = Partial<
  Readonly<Record<RecurringPayVia, PayViaEntry>>
>;

/**
 * The draft's changes once "How it's paid" moves to `payVia`, whose amount
 * is typed in `currency`. What that way had earlier in this edit comes
 * back, starting with what the form opened with, so a look at another way
 * doesn't lose a card's estimate and card. Otherwise the amount carries
 * over unless its currency changes. `memory` gains what the way being left
 * has.
 */
export function switchPayVia(
  draft: RecurringDraft,
  memory: PayViaMemory,
  payVia: RecurringPayVia,
  currency: BillCurrency,
): {
  readonly changes: Partial<RecurringDraft>;
  readonly memory: PayViaMemory;
} {
  const kept: PayViaMemory = {
    ...memory,
    [draft.payVia]: {
      currency: draft.currency,
      amount: draft.amount,
      cardId: draft.cardId,
    },
  };
  const earlier = kept[payVia];
  const amount =
    earlier?.currency === currency
      ? earlier.amount
      : currency === draft.currency
        ? draft.amount
        : "";
  return {
    changes: {
      payVia,
      currency,
      amount,
      cardId: payVia === "card" ? (earlier?.cardId ?? null) : null,
    },
    memory: kept,
  };
}

/** Only the fields that changed; an empty request changes nothing. */
export function toUpdateRequest(
  item: RecurringItem,
  draft: RecurringDraft,
): UpdateRecurringItemRequest {
  const request: UpdateRecurringItemRequest = {};
  const { typed: typedAmount } = amountOfDraft(draft);
  const typedUnits =
    typedAmount === null
      ? null
      : (parseTyped(draft.currency, typedAmount) ?? typedAmount);
  if (draft.currency !== item.currency || typedUnits !== storedAmount(item)) {
    if (draft.currency === "usd") request.amountUsd = typedAmount;
    else request.amountKes = typedAmount;
  }
  // Only a move to or from a company-held card changes how it's paid (spec §6.20).
  const toOrFromCard =
    draft.payVia !== item.payVia &&
    (draft.payVia === "card" || item.payVia === "card");
  const cardChanged =
    draft.payVia === "card" && draft.cardId !== (item.card?.id ?? null);
  if (toOrFromCard || cardChanged) {
    request.payVia = draft.payVia;
    if (draft.payVia === "card") request.cardId = draft.cardId ?? undefined;
  }
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

const STATE_ORDER: Readonly<Record<RecurringItemState, number>> = {
  active: 0,
  paused: 1,
  ended: 2,
};

/** Active, then paused, then ended; within each, the soonest due first, then by payee. */
export function sortRecurringItems(
  items: readonly RecurringItem[],
): RecurringItem[] {
  const dueKey = (item: RecurringItem) => nextDueDate(item) ?? "9999-12-31";
  return [...items].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      dueKey(a).localeCompare(dueKey(b)) ||
      a.payee.name.localeCompare(b.payee.name),
  );
}

/**
 * The most of a schedule's bills one calendar month can hold. Lithic's
 * limit is per month, so a quarterly or yearly bill needs its whole amount
 * in the month it falls in, and a month can hold five weekly ones.
 */
const MOST_BILLS_IN_A_MONTH: Readonly<Record<RecurringSchedule, bigint>> = {
  weekly: 5n,
  monthly: 1n,
  quarterly: 1n,
  yearly: 1n,
};

const divideUp = (amount: bigint, by: bigint): bigint =>
  (amount + by - 1n) / by;

export interface CardPaymentEstimate {
  /** USDC base units; null when the payment has no estimate. */
  readonly amountUsdc: string | null;
  readonly schedule: RecurringSchedule;
}

/** In USDC base units; 0 when none has an estimate. */
const mostInOneMonthUsdc = (payments: readonly CardPaymentEstimate[]) =>
  payments.reduce(
    (sum, payment) =>
      payment.amountUsdc === null
        ? sum
        : sum +
          BigInt(payment.amountUsdc) * MOST_BILLS_IN_A_MONTH[payment.schedule],
    0n,
  );

/**
 * The most a company-held card's recurring payments can charge in one
 * calendar month, in US cents rounded up. Null when none has an estimate.
 */
export function mostInOneMonthCents(
  payments: readonly CardPaymentEstimate[],
): bigint | null {
  const most = mostInOneMonthUsdc(payments);
  return most === 0n ? null : divideUp(most, USDC_UNITS_PER_US_CENT);
}

/**
 * The monthly limit suggested for a company-held card (spec §6.25): the
 * most its recurring payments can charge in one month plus
 * CARD_LIMIT_HEADROOM_PERCENT, in US cents rounded up. Null when none has
 * an estimate.
 */
export function suggestedCardLimitCents(
  payments: readonly CardPaymentEstimate[],
): bigint | null {
  const most = mostInOneMonthUsdc(payments);
  if (most === 0n) return null;
  const withHeadroom = divideUp(
    most * BigInt(100 + CARD_LIMIT_HEADROOM_PERCENT),
    100n,
  );
  return divideUp(withHeadroom, USDC_UNITS_PER_US_CENT);
}

/** What the card's other recurring payments add to a month: those that haven't ended. */
export function otherCardPayments(
  items: readonly RecurringItem[],
  cardId: string,
  exceptItemId: string | null,
): CardPaymentEstimate[] {
  return items
    .filter(
      (item) =>
        item.card?.id === cardId &&
        item.id !== exceptItemId &&
        item.state !== "ended",
    )
    .map((item) => ({
      amountUsdc: item.currency === "usd" ? item.amountUsdc : null,
      schedule: item.schedule,
    }));
}

export function reminderInWords(days: number): string {
  if (days === 0) return "On the due date";
  return `${String(days)} ${days === 1 ? "day" : "days"} before it’s due`;
}

const DAY_MS = 86_400_000;
const MONTHS_APART: Readonly<
  Record<Exclude<RecurringSchedule, "weekly">, number>
> = { monthly: 1, quarterly: 3, yearly: 12 };

function toUtc(isoDate: string): Date {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const toIso = (date: Date): string => date.toISOString().slice(0, 10);

function monthNumber(isoDate: string): number {
  const date = toUtc(isoDate);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function dayOfMonth(month: number, day: number): string {
  const year = Math.floor(month / 12);
  const monthOfYear = month % 12;
  const lastDay = new Date(Date.UTC(year, monthOfYear + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(year, monthOfYear, Math.min(day, lastDay))));
}

/**
 * The first bill's due date, as the API works it out
 * (`apps/api/src/services/recurring/schedule.ts`): the first day the
 * schedule falls on from `startsOn`; null when that's past `endsOn`.
 */
export function firstDueOn({
  schedule,
  scheduleDay,
  startsOn,
  endsOn,
}: {
  schedule: RecurringSchedule;
  scheduleDay: number;
  startsOn: string;
  endsOn: string | null;
}): string | null {
  let due: string;
  if (schedule === "weekly") {
    const start = toUtc(startsOn);
    const ahead = (scheduleDay - isoWeekday(startsOn) + 7) % 7;
    due = toIso(new Date(start.getTime() + ahead * DAY_MS));
  } else {
    const first = monthNumber(startsOn);
    const inStartMonth = dayOfMonth(first, scheduleDay);
    due =
      inStartMonth >= startsOn
        ? inStartMonth
        : dayOfMonth(first + MONTHS_APART[schedule], scheduleDay);
  }
  return endsOn !== null && endsOn !== "" && due > endsOn ? null : due;
}
