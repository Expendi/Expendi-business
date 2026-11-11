import type {
  OverviewPayment,
  SpendingOverview,
} from "@expendi-business/shared";

import { formatKesCents } from "../../lib/money";
import { formatDayMonth, formatShortDate } from "../claims/dates";
import { shiftMonth } from "../overview/overview-display";

/** What the Expenses tab shows of the overview: money already spent. */

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

export const MONTH_CHOICES = 12;

/** `2026-10` → `October`; the year is added when it isn't `currentMonth`'s. */
export function monthName(month: string, currentMonth: string): string {
  const [year = "", number = ""] = month.split("-");
  const name = MONTH_NAMES[Number(number) - 1];
  if (name === undefined) return month;
  return year === currentMonth.slice(0, 4) ? name : `${name} ${year}`;
}

export interface MonthChoice {
  /** What `useOverview` takes: "" is this month. */
  value: string;
  label: string;
}

/** This month and the 11 before it, newest first. */
export function monthChoices(currentMonth: string): MonthChoice[] {
  return Array.from({ length: MONTH_CHOICES }, (_, index) => {
    const month = shiftMonth(currentMonth, -index);
    return {
      value: index === 0 ? "" : month,
      label: monthName(month, currentMonth),
    };
  });
}

export function isCurrentMonth(overview: SpendingOverview): boolean {
  return overview.month === overview.cash.today.slice(0, 7);
}

export function spentLabel(overview: SpendingOverview): string {
  return isCurrentMonth(overview)
    ? "Spent this month"
    : `Spent in ${monthName(overview.month, overview.cash.today.slice(0, 7))}`;
}

/** "1–11 Nov · October in full: 735,084.00", or just the last part for a past month. */
export function comparisonLine(overview: SpendingOverview): string {
  const currentMonth = overview.cash.today.slice(0, 7);
  const previous = `${monthName(overview.previousMonth, currentMonth)} in full: ${formatKesCents(overview.previousKes)}`;
  if (!isCurrentMonth(overview)) return previous;
  const today = overview.cash.today;
  const range =
    today.endsWith("-01")
      ? formatDayMonth(today)
      : `1–${formatDayMonth(today)}`;
  return `${range} · ${previous}`;
}

export interface HeadingBar {
  id: string;
  name: string;
  amount: string;
  /** Share of the month's total in tenths of a percent, 0 to 1000. */
  permille: number;
  note: string | null;
}

function permilleOf(part: bigint, total: bigint): number {
  if (total <= 0n || part <= 0n) return 0;
  const share = Number((part * 1000n) / total);
  return Math.min(share, 1000);
}

/** Salaries read 0.00 until payroll runs; say when it does if the data knows. */
function headingNote(
  heading: SpendingOverview["headings"][number],
  overview: SpendingOverview,
): string | null {
  if (heading.id !== "salaries" || BigInt(heading.currentKes) !== 0n) {
    return null;
  }
  if (!isCurrentMonth(overview)) return null;
  const { today, obligations } = overview.cash;
  const next = obligations.find(
    (row) => row.kind === "payroll" && row.dueOn >= today,
  );
  return next ? `Payroll runs ${formatShortDate(next.dueOn, today)}` : null;
}

export function headingBars(overview: SpendingOverview): HeadingBar[] {
  const total = BigInt(overview.currentKes);
  return overview.headings.map((heading) => ({
    id: heading.id,
    name: heading.name,
    amount: formatKesCents(heading.currentKes),
    permille: permilleOf(BigInt(heading.currentKes), total),
    note: headingNote(heading, overview),
  }));
}

/** Categories with spending this month, biggest first. */
export function categoriesSpent(
  overview: SpendingOverview,
): SpendingOverview["categories"] {
  return overview.categories
    .filter((row) => BigInt(row.currentKes) > 0n)
    .sort((a, b) => {
      const difference = BigInt(b.currentKes) - BigInt(a.currentKes);
      return difference === 0n ? a.name.localeCompare(b.name) : difference > 0n ? 1 : -1;
    });
}

export type ExpenseFilter = "all" | "reimbursements" | "petty_cash" | "company";

export const EXPENSE_FILTERS: readonly { value: ExpenseFilter; label: string }[] =
  [
    { value: "all", label: "All" },
    { value: "reimbursements", label: "Reimbursements" },
    { value: "petty_cash", label: "Petty cash" },
    { value: "company", label: "Company" },
  ];

/**
 * The API's `kind` says what the money was: a reimbursement (`claim`), a
 * float's spending (`float`), or the company's own (`company`, and `bill`
 * whether paid through Expendi or recorded as paid outside).
 */
export function filterOf(kind: OverviewPayment["kind"]): Exclude<ExpenseFilter, "all"> {
  switch (kind) {
    case "claim":
      return "reimbursements";
    case "float":
      return "petty_cash";
    case "company":
    case "bill":
      return "company";
  }
}

export function filterPayments(
  payments: readonly OverviewPayment[],
  filter: ExpenseFilter,
): OverviewPayment[] {
  return filter === "all"
    ? [...payments]
    : payments.filter((payment) => filterOf(payment.kind) === filter);
}

const KIND_WORDS: Record<OverviewPayment["kind"], string> = {
  claim: "reimbursement",
  float: "petty cash",
  company: "company",
  bill: "bill",
};

export interface PaymentMeta {
  text: string;
  noReceipt: boolean;
}

/**
 * "Brian Otieno · reimbursement · Fri 6 Nov". A float payment's id is its
 * expense's id, which is how `outstanding.noReceipt` names it.
 */
export function paymentMeta(
  payment: OverviewPayment,
  overview: SpendingOverview,
): PaymentMeta {
  const person = payment.personId
    ? overview.people.find((row) => row.id === payment.personId)?.name
    : undefined;
  const noReceipt =
    payment.kind === "float" &&
    overview.outstanding.noReceipt.some((row) => row.id === payment.id);
  const kind = KIND_WORDS[payment.kind];
  const parts = [
    person ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
    person === undefined ? null : kind,
    formatShortDate(payment.date, overview.cash.today),
    noReceipt ? "no receipt" : null,
  ].filter((part) => part !== null);
  return { text: parts.join(" · "), noReceipt };
}
