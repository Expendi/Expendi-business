import type { Bill, BillStatus } from "@expendi-business/shared";

/** Unpaid and in-flight bills, most urgent first (spec §6.20). */
export const OPEN_BILL_GROUPS = [
  { status: "overdue", title: "Overdue" },
  { status: "due", title: "Due today" },
  { status: "payout_failed", title: "Payment failed" },
  { status: "paying", title: "Being paid" },
  { status: "upcoming", title: "Upcoming" },
] as const satisfies readonly { status: BillStatus; title: string }[];

export const OPEN_BILL_STATUSES = OPEN_BILL_GROUPS.map((group) => group.status);

export const HISTORY_BILL_STATUSES = [
  "paid",
  "paid_outside",
  "paid_by_card",
  "cancelled",
] as const satisfies readonly BillStatus[];

/** How far back the history on the bills screen goes. */
export const HISTORY_DAYS = 180;

export interface BillGroup {
  status: BillStatus;
  title: string;
  bills: Bill[];
}

/** The open groups that have bills, each in due-date order as the API sends them. */
export function groupOpenBills(bills: readonly Bill[]): BillGroup[] {
  return OPEN_BILL_GROUPS.flatMap(({ status, title }) => {
    const inGroup = bills.filter((bill) => bill.status === status);
    return inGroup.length > 0 ? [{ status, title, bills: inGroup }] : [];
  });
}

/** The day a settled bill was settled: paid, or cancelled; its due date otherwise. */
export function settledOn(bill: Bill): string {
  return bill.paidOn ?? bill.cancelledAt?.slice(0, 10) ?? bill.dueOn;
}

/** Paid and cancelled bills, most recently settled first. */
export function historyNewestFirst(bills: readonly Bill[]): Bill[] {
  return [...bills].sort((a, b) => {
    const byDay = settledOn(b).localeCompare(settledOn(a));
    return byDay !== 0 ? byDay : b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** `YYYY-MM-DD` moved by whole days, with calendar arithmetic only. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}
