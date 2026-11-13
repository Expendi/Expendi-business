import type {
  BillCurrency,
  BillHeading,
  CardState,
  CreateRecurringItemRequest,
  RecurringItem,
  RecurringItemState,
  RecurringPayVia,
  RecurringSchedule,
  UpdateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  describeSchedule,
  REMINDER_DAYS_DEFAULT,
} from "@expendi-business/shared";

import type { BadgeFields } from "../bills/bill-badges";
import {
  currencyOfPayee,
  formatBillAmount,
  parseTyped,
  storedAmount,
  toTyped,
} from "../bills/bill-amount";
import {
  byCompanyHeldCard,
  cardDeclined,
  formatEstimate,
} from "../bills/bill-card";
import { blankToNull } from "../bills/bill-draft";
import { CARD_STATE_BADGES, maskedCardNumber } from "../cards/card-display";

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
    currency: "kes",
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
    ...(draft.currency === "usd"
      ? { amountUsd: draft.variable ? null : blankToNull(draft.amount) }
      : { amountKes: draft.variable ? null : blankToNull(draft.amount) }),
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

/**
 * The payment as its form starts, its amount in the payee's currency as it
 * is now: blank if their method moved between KES and USDC since. A
 * company-held card's estimate is always in USD, whatever the payee's
 * method, so its amount goes back as `amountUsd`.
 */
export function draftFromItem(item: RecurringItem): RecurringDraft {
  const currency =
    item.payVia === "card"
      ? "usd"
      : currencyOfPayee(item.payee.method, item.currency);
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
  const typedUnits =
    typedAmount === null
      ? null
      : (parseTyped(draft.currency, typedAmount) ?? typedAmount);
  if (draft.currency !== item.currency || typedUnits !== storedAmount(item)) {
    if (draft.currency === "usd") request.amountUsd = typedAmount;
    else request.amountKes = typedAmount;
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

/**
 * The bill still owed, as its badges read it: the payment's card pays it,
 * and the payment's state can stop that card.
 */
export function nextBillBadgeFields(item: RecurringItem): BadgeFields | null {
  const bill = item.nextBill;
  if (bill === null) return null;
  return {
    status: bill.status,
    card: item.payVia === "card" ? item.card : null,
    cardDeclinedAt: bill.cardDeclinedAt ?? null,
    recurring: { state: item.state },
  };
}

/** The card declined a Card purchase meant for the bill still owed. */
export function nextBillCardDeclined(item: RecurringItem): boolean {
  const bill = nextBillBadgeFields(item);
  return bill !== null && cardDeclined(bill);
}

export function scheduleInWords(
  item: Pick<RecurringItem, "schedule" | "scheduleDay" | "startsOn">,
): string {
  return describeSchedule(item.schedule, item.scheduleDay, item.startsOn);
}

type PaidBy = Pick<RecurringItem, "payVia" | "card">;

/**
 * "Card •••• 1234", noting a frozen or closed card, which declines Card
 * purchases; null unless a company-held card pays it.
 */
export function payingCardLabel(item: PaidBy): string | null {
  if (item.payVia !== "card") return null;
  if (!item.card) return "Company-held card";
  const label = `Card ${maskedCardNumber(item.card.lastFour)}`;
  return item.card.state === "open"
    ? label
    : `${label} · ${CARD_STATE_BADGES[item.card.state].label}`;
}

const CARD_STATE_WARNINGS: Record<CardState, string | null> = {
  open: null,
  frozen:
    "The card is frozen, so Card purchases are declined until it’s unfrozen on the web dashboard.",
  closed:
    "The card is closed. Move this payment to another card on the web dashboard.",
};

export function payViaInWords(
  item: PaidBy & { readonly payee: Pick<RecurringItem["payee"], "name"> },
): string {
  switch (item.payVia) {
    case "expendi":
      return "Through Expendi";
    case "outside":
      return "Outside Expendi. Mark each bill paid once you’ve paid it.";
    case "card": {
      const warning = item.card ? CARD_STATE_WARNINGS[item.card.state] : null;
      const paid = `${byCompanyHeldCard(item.card)}. Each bill is paid when ${item.payee.name} charges the card.`;
      return warning ? `${paid} ${warning}` : paid;
    }
  }
}

/** A company-held card's amount is only an estimate of what the payee charges. */
export function recurringAmount(
  item: Pick<RecurringItem, "payVia" | "currency" | "amountKes" | "amountUsdc">,
  withoutAmount: string,
): string {
  return item.payVia === "card"
    ? formatEstimate(item)
    : (formatBillAmount(item) ?? withoutAmount);
}

/** A card-paid bill is reminded of only once it's overdue (spec §6.20). */
export function reminderInWords(
  item: Pick<RecurringItem, "payVia" | "reminderDays">,
): string {
  if (item.payVia === "card") return "Only if a bill goes overdue";
  return item.reminderDays === 0
    ? "On the due date"
    : `${item.reminderDays} ${item.reminderDays === 1 ? "day" : "days"} before it’s due`;
}
