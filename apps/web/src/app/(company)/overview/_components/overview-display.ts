import type {
  CashObligation,
  FloatSummary,
  LargestPayment,
  ReportSpending,
  SpendingOverview,
} from "@expendi-business/shared";

import { formatIsoDate } from "~/lib/dates";
import { kesValue } from "../../reports/_components/viz/scale";

/** "Good morning, Wanjiru" by the hour in Nairobi. */
export function greeting(hour: number, fullName: string | null): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const firstName = fullName?.trim().split(/\s+/)[0];
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`;
}

const NAIROBI_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "numeric",
  hourCycle: "h23",
});

export function nairobiHour(at: Date): number {
  return Number(NAIROBI_HOUR.format(at));
}

/** `2026-11-04` → "4 Nov". */
export function dayMonth(isoDate: string): string {
  return formatIsoDate(isoDate).replace(/ \d{4}$/, "");
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * Where a due payment is handled: the bill's sheet, the payroll run, or
 * for a forecast the salary or recurring payment it will be billed from.
 */
export function obligationHref(row: CashObligation): string {
  switch (row.kind) {
    case "bill":
      return `/bills?billId=${row.id}`;
    case "payroll":
      return `/payroll?runId=${row.id}`;
    case "forecast":
      return row.heading === "salaries"
        ? "/payroll"
        : `/bills?recurring=${row.id}`;
  }
}

function describeObligation(row: CashObligation): string {
  const people =
    row.kind === "payroll" && row.people !== null
      ? `${String(row.people)} ${row.people === 1 ? "person" : "people"}`
      : null;
  return [row.notes, people ?? row.schedule].filter(Boolean).join(", ");
}

/** What a due payment is for: "PAYE for October", "Water bill, monthly", "14 people". */
export function obligationWhat(row: CashObligation): string {
  const what = describeObligation(row);
  if (what) return what;
  return row.kind === "forecast"
    ? "Not billed yet"
    : `Due ${dayMonth(row.dueOn)}`;
}

/** An inbox payment's second line: what it's for and, when late, when it was due. */
export function paymentMeta(row: CashObligation, overdueDays: number): string {
  const what = describeObligation(row);
  if (overdueDays === 0) return what;
  const due = `due ${dayMonth(row.dueOn)}`;
  return what ? `${what}, ${due}` : `Due ${dayMonth(row.dueOn)}`;
}

export type InboxKind = "payment" | "claim" | "receipt" | "etims";

type OutstandingExpense = SpendingOverview["outstanding"]["claims"][number];

export type InboxItem =
  | {
      readonly kind: "payment";
      readonly id: string;
      readonly row: CashObligation;
      readonly overdueDays: number;
    }
  | {
      readonly kind: "claim" | "receipt" | "etims";
      readonly id: string;
      readonly row: OutstandingExpense;
    };

export interface InboxGroup {
  readonly id: "payments" | "approvals" | "documents";
  readonly title: string;
  readonly items: readonly InboxItem[];
}

/** What needs someone today: payments due, reimbursements waiting, missing documents. */
export function inboxGroups(data: SpendingOverview): InboxGroup[] {
  const today = data.cash.today;
  const payments: InboxItem[] = [
    ...data.outstanding.overdue,
    ...data.outstanding.dueToday,
  ].map((row) => ({
    kind: "payment",
    id: `${row.kind}:${row.id}`,
    row,
    overdueDays: Math.max(0, daysBetween(row.dueOn, today)),
  }));
  const groups: InboxGroup[] = [
    { id: "payments", title: "Payments", items: payments },
    {
      id: "approvals",
      title: "Approvals",
      items: data.outstanding.claims.map((row) => ({
        kind: "claim",
        id: `claim:${row.id}`,
        row,
      })),
    },
    {
      id: "documents",
      title: "Missing documents",
      items: [
        ...data.outstanding.noReceipt.map((row) => ({
          kind: "receipt" as const,
          id: `receipt:${row.id}`,
          row,
        })),
        ...data.outstanding.noEtims.map((row) => ({
          kind: "etims" as const,
          id: `etims:${row.id}`,
          row,
        })),
      ],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

export function inboxTitle(count: number, canAct: boolean): string {
  if (count === 0) return "You're all caught up";
  if (!canAct) {
    return `${String(count)} ${count === 1 ? "thing is" : "things are"} waiting`;
  }
  return `${String(count)} ${count === 1 ? "thing needs" : "things need"} you`;
}

export function overdueLabel(days: number): string {
  return `Overdue ${String(days)} ${days === 1 ? "day" : "days"}`;
}

/** The second line of an expense row: what, where and when, then the category or float. */
export function expenseMeta(
  row: OutstandingExpense,
  kind: "claim" | "receipt" | "etims",
): string {
  const what =
    kind !== "claim"
      ? (row.description ?? row.categoryName)
      : row.description
        ? `${row.description} at ${row.name}`
        : row.name;
  const where =
    kind === "claim" ? row.categoryName : `${row.personName}'s float`;
  return `${what} on ${dayMonth(row.spentOn)} · ${where}`;
}

/** Due after today, in date order: the "Coming up" list. */
export function comingUp(
  cash: SpendingOverview["cash"],
): readonly CashObligation[] {
  return cash.obligations
    .filter((row) => row.dueOn > cash.today)
    .slice()
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/**
 * The wallet's figures for the next 30 days. Money still leaving is what the
 * balance holds beyond what's available; what's left over is available minus
 * what's due. Null where the KES rate is missing.
 */
export function cashLedger(cash: SpendingOverview["cash"]): {
  readonly inProgressKes: string | null;
  readonly leftOverKes: string | null;
} {
  if (cash.balanceKes === null || cash.availableKes === null) {
    return { inProgressKes: null, leftOverKes: null };
  }
  const inProgress = BigInt(cash.balanceKes) - BigInt(cash.availableKes);
  const leftOver = BigInt(cash.availableKes) - BigInt(cash.totalKes);
  return {
    inProgressKes: (inProgress > 0n ? inProgress : 0n).toString(),
    leftOverKes: leftOver.toString(),
  };
}

/** The open floats lowest first, with what's left as a share of what was issued. */
export function floatRows(floats: readonly FloatSummary[]): {
  readonly float: FloatSummary;
  readonly share: number;
  readonly low: boolean;
}[] {
  return floats
    .filter((float) => float.status === "open")
    .map((float) => {
      const issued = kesValue(float.issuedKes);
      const share =
        issued > 0 ? Math.max(0, kesValue(float.leftKes) / issued) : 0;
      return { float, share, low: issued > 0 && share < 0.25 };
    })
    .slice()
    .sort((a, b) => a.share - b.share);
}

/** Whole-shilling money out of the shown months, lined up with `months`. */
export interface SpendingSeries {
  readonly months: readonly string[];
  readonly total: readonly number[];
  readonly outsidePayroll: readonly number[];
}

/** The months the API sent after the comparison month it adds first. */
export function spendingSeries(spending: ReportSpending): SpendingSeries {
  const shown = spending.months.slice(1);
  return {
    months: shown.map((month) => month.month),
    total: shown.map((month) => kesValue(month.totalKes)),
    outsidePayroll: shown.map(
      (month) => kesValue(month.totalKes) - kesValue(month.headings.salaries),
    ),
  };
}

export interface CategoryBar {
  readonly id: string;
  readonly name: string;
  readonly current: number;
  readonly previous: number;
}

/**
 * Money out by category outside payroll, this month against the one
 * before: the five largest, then the rest as "Other".
 */
export function categoryBars(spending: ReportSpending): CategoryBar[] {
  const last = spending.months.length - 1;
  const outside = (month: ReportSpending["months"][number] | undefined) =>
    month ? kesValue(month.totalKes) - kesValue(month.headings.salaries) : 0;
  const rows = spending.categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      current: outside(category.months[last]),
      previous: outside(category.months[last - 1]),
    }))
    .filter((row) => row.current > 0 || row.previous > 0)
    .slice()
    .sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
  if (rows.length <= 6) return rows;
  const rest = rows.slice(5);
  return [
    ...rows.slice(0, 5),
    {
      id: "other",
      name: "Other",
      current: rest.reduce((sum, row) => sum + row.current, 0),
      previous: rest.reduce((sum, row) => sum + row.previous, 0),
    },
  ];
}

/** The category whose rise added the most, with its change in percent. */
export function biggestRise(bars: readonly CategoryBar[]): {
  readonly name: string;
  readonly percent: number;
  readonly share: number;
} | null {
  const rise = bars.reduce((sum, bar) => sum + (bar.current - bar.previous), 0);
  const top = bars
    .filter((bar) => bar.id !== "other" && bar.previous > 0)
    .slice()
    .sort((a, b) => b.current - b.previous - (a.current - a.previous))[0];
  if (!top || top.current <= top.previous) return null;
  return {
    name: top.name,
    percent: Math.round((top.current / top.previous - 1) * 100),
    share:
      rise > 0 ? Math.round(((top.current - top.previous) / rise) * 100) : 0,
  };
}

/**
 * The month's largest payments outside payroll: categories whose money out
 * that month was all salaries are left out.
 */
export function largestPayments(
  spending: ReportSpending,
  count = 5,
): LargestPayment[] {
  const last = spending.months.length - 1;
  const payroll = new Set(
    spending.categories
      .filter((category) => {
        const month = category.months[last];
        return (
          month !== undefined &&
          BigInt(month.totalKes) > 0n &&
          month.headings.salaries === month.totalKes
        );
      })
      .map((category) => category.id),
  );
  return spending.largestPayments
    .filter((payment) => !payroll.has(payment.categoryId))
    .slice()
    .sort((a, b) => {
      const difference = BigInt(b.amountKes) - BigInt(a.amountKes);
      return difference > 0n ? 1 : difference < 0n ? -1 : 0;
    })
    .slice(0, count);
}
