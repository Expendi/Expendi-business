import type { Bill } from "@expendi-business/shared";

import { dayCount, daysBetween, formatShortDate } from "../claims/dates";
import { formatKesCents, formatUsdc } from "../../lib/money";
import { settledOn, shiftIsoDate } from "./bill-groups";
import type { BillAmountFields } from "./bill-amount";
import { storedAmount } from "./bill-amount";

/** The three views of the Bills tab (Ramp model: owed, in flight, settled). */
export type BillsView = "to-pay" | "paying" | "history";

/** Bills due within this many days of today count as "This week". */
export const THIS_WEEK_DAYS = 7;

export interface ToPaySection {
  key: "overdue" | "failed" | "week" | "later";
  title: string;
  bills: Bill[];
}

/** Salary bills belong to their payroll run and are paid from Payroll. */
export function withoutPayrollBills(bills: readonly Bill[]): Bill[] {
  return bills.filter((bill) => bill.payrollRunId === null);
}

/** Unpaid bills the admin still has to deal with: everything open except in-flight ones. */
export function toPayBills(open: readonly Bill[]): Bill[] {
  return open.filter((bill) => bill.status !== "paying");
}

export function beingPaidBills(open: readonly Bill[]): Bill[] {
  return open.filter((bill) => bill.status === "paying");
}

/** To pay, split into Overdue, Payment failed, This week and Later; empty sections are dropped. */
export function toPaySections(
  bills: readonly Bill[],
  today: string,
): ToPaySection[] {
  const weekEnd = shiftIsoDate(today, THIS_WEEK_DAYS);
  const sections: ToPaySection[] = [
    { key: "overdue", title: "Overdue", bills: [] },
    { key: "failed", title: "Payment failed", bills: [] },
    { key: "week", title: "This week", bills: [] },
    { key: "later", title: "Later", bills: [] },
  ];
  const [overdue, failed, week, later] = sections as [
    ToPaySection,
    ToPaySection,
    ToPaySection,
    ToPaySection,
  ];
  for (const bill of bills) {
    if (bill.status === "overdue") overdue.bills.push(bill);
    else if (bill.status === "payout_failed") failed.bills.push(bill);
    else if (bill.status === "due" || bill.dueOn <= weekEnd) week.bills.push(bill);
    else later.bills.push(bill);
  }
  return sections.filter((section) => section.bills.length > 0);
}

export interface ToPayTotal {
  /** The sum of the KES bills that have an amount, in cents. */
  kesCents: string;
  /** USD bills with an amount: never added into the KES total. */
  usdBills: number;
  /** Bills of either currency still waiting for their amount. */
  awaitingAmount: number;
}

export function toPayTotal(bills: readonly Bill[]): ToPayTotal {
  let kes = 0n;
  let usdBills = 0;
  let awaitingAmount = 0;
  for (const bill of bills) {
    const stored = storedAmount(bill);
    if (stored === null) awaitingAmount += 1;
    else if (bill.currency === "usd") usdBills += 1;
    else kes += BigInt(stored);
  }
  return { kesCents: kes.toString(), usdBills, awaitingAmount };
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** What the KES total leaves out, or null when it counts everything. */
export function totalExclusionNote(total: ToPayTotal): string | null {
  const parts = [
    total.usdBills > 0 ? plural(total.usdBills, "USD bill", "USD bills") : null,
    total.awaitingAmount > 0
      ? `${plural(total.awaitingAmount, "bill", "bills")} waiting for an amount`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Not counting ${parts.join(" and ")}.`;
}

/** "1 overdue · 8,999.00": the KES owed on overdue bills; null when none is overdue. */
export function overdueSummary(bills: readonly Bill[]): string | null {
  const overdue = bills.filter((bill) => bill.status === "overdue");
  if (overdue.length === 0) return null;
  const { kesCents } = toPayTotal(overdue);
  const count = `${String(overdue.length)} overdue`;
  return kesCents === "0" ? count : `${count} · ${formatKesCents(kesCents)}`;
}

/** The amount for a row: bare KES (the figure is KES), "USD 120.50" for USD; null while missing. */
export function rowAmount(bill: BillAmountFields): string | null {
  const stored = storedAmount(bill);
  if (stored === null) return null;
  return bill.currency === "usd"
    ? `USD ${formatUsdc(stored)}`
    : formatKesCents(stored);
}

export interface BillWhen {
  text: string;
  negative: boolean;
}

/** The row's second line: when it's due, how late it is, or when it was settled. */
export function billWhen(bill: Bill, today: string): BillWhen {
  const recurring = bill.recurringItemId === null ? "" : " · recurring";
  const on = (isoDate: string): string => formatShortDate(isoDate, today);
  switch (bill.status) {
    case "paid":
      return { text: `Paid ${on(settledOn(bill))}${recurring}`, negative: false };
    case "paid_outside":
      return {
        text: `Paid outside Expendi · ${on(settledOn(bill))}`,
        negative: false,
      };
    case "cancelled":
      return { text: `Cancelled · ${on(settledOn(bill))}`, negative: false };
    case "payout_failed":
      return { text: `Payment failed · due ${on(bill.dueOn)}`, negative: true };
    case "paying":
      return { text: `Being paid · due ${on(bill.dueOn)}`, negative: false };
    case "overdue": {
      const late = daysBetween(bill.dueOn, today);
      return {
        text: `${late !== null && late > 0 ? `${dayCount(late)} late` : "Overdue"}${recurring}`,
        negative: true,
      };
    }
    case "due":
      return { text: `Due today${recurring}`, negative: false };
    case "upcoming":
      return { text: `${on(bill.dueOn)}${recurring}`, negative: false };
  }
}
