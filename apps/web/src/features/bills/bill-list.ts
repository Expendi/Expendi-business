import type {
  Bill,
  BillHeading,
  BillListView,
  BillMethodFilter,
  BillSource,
  BillStatus,
} from "@expendi-business/shared";
import {
  BILL_HEADINGS,
  BILL_LIST_VIEW_STATUSES,
  BILL_LIST_VIEWS,
  BILL_METHOD_FILTERS,
  BILL_SOURCES,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import { usdcToKesCents } from "~/lib/money";
import { storedAmount } from "./bill-amount";
import {
  daysBetween,
  HISTORY_DAYS,
  nairobiIsoDate,
  shiftIsoDate,
} from "./bill-dates";

/**
 * The Bills list as the page asks for it (spec §6.20): a tab (To pay,
 * Being paid, History) and the filter chips, all kept in the URL, and the
 * order the table shows. Salaries never show: they belong to Payroll.
 */

export interface BillFilters {
  readonly status: BillStatus | null;
  readonly payeeId: string | null;
  readonly categoryId: string | null;
  readonly heading: BillHeading | null;
  readonly method: BillMethodFilter | null;
  readonly source: BillSource | null;
}

export const NO_BILL_FILTERS: BillFilters = {
  status: null,
  payeeId: null,
  categoryId: null,
  heading: null,
  method: null,
  source: null,
};

/** Each filter's name in the page's URL. */
export const BILL_FILTER_PARAMS = {
  status: "status",
  payeeId: "payee",
  categoryId: "category",
  heading: "heading",
  method: "method",
  source: "source",
} as const satisfies Record<keyof BillFilters, string>;

export type BillFilterParam = (typeof BILL_FILTER_PARAMS)[keyof BillFilters];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(
  options: readonly T[],
  value: string | null,
): T | null {
  return options.find((option) => option === value) ?? null;
}

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

/** The tab in the URL; To pay unless it names another. */
export function viewFromParam(value: string | null): BillListView {
  return oneOf(BILL_LIST_VIEWS, value) ?? "open";
}

/** The tab a bill shows under: still to pay, being paid, or settled. */
export function viewOfStatus(status: BillStatus): BillListView {
  if (isUnpaid(status)) return "open";
  return status === "paying" ? "paying" : "history";
}

/** The statuses the Status chip offers on a tab; none on Being paid. */
export function statusesOf(view: BillListView): readonly BillStatus[] {
  return view === "paying" ? [] : BILL_LIST_VIEW_STATUSES[view];
}

/** The filters in the URL, leaving out any value the tab or the API wouldn't take. */
export function filtersFromParams(
  view: BillListView,
  read: (name: BillFilterParam) => string | null,
): BillFilters {
  const id = (name: BillFilterParam) => {
    const value = read(name);
    return value !== null && UUID.test(value) ? value : null;
  };
  return {
    status: oneOf(statusesOf(view), read(BILL_FILTER_PARAMS.status)),
    payeeId: id(BILL_FILTER_PARAMS.payeeId),
    categoryId: id(BILL_FILTER_PARAMS.categoryId),
    heading: oneOf(BILL_HEADINGS, read(BILL_FILTER_PARAMS.heading)),
    method: oneOf(BILL_METHOD_FILTERS, read(BILL_FILTER_PARAMS.method)),
    source: oneOf(BILL_SOURCES, read(BILL_FILTER_PARAMS.source)),
  };
}

export function anyFilterSet(filters: BillFilters): boolean {
  return Object.values(filters).some((value) => value !== null);
}

/** History goes back six months from today in Nairobi. */
export function historySettledFrom(today: string): string {
  return shiftIsoDate(today, -HISTORY_DAYS);
}

/** `GET …/bills/summary`'s filters: the list's, without a tab or status. */
export interface BillSummaryParams {
  readonly payeeId?: string;
  readonly categoryId?: string;
  readonly heading?: BillHeading;
  readonly method?: BillMethodFilter;
  readonly source?: BillSource;
  readonly settledFrom?: string;
}

export function summaryParams(
  filters: BillFilters,
  settledFrom: string,
): BillSummaryParams {
  const { payeeId, categoryId, heading, method, source } = filters;
  return {
    ...(payeeId && { payeeId }),
    ...(categoryId && { categoryId }),
    ...(heading && { heading }),
    ...(method && { method }),
    ...(source && { source }),
    settledFrom,
  };
}

/** `GET …/bills`'s query: always without salaries, History since `settledFrom`. */
export interface BillListParams extends BillSummaryParams {
  readonly view: BillListView;
  readonly status?: BillStatus;
  readonly excludePayroll: true;
}

export function listParams(
  view: BillListView,
  filters: BillFilters,
  today: string,
): BillListParams {
  const { settledFrom, ...rest } = summaryParams(
    filters,
    historySettledFrom(today),
  );
  return {
    view,
    ...(filters.status && { status: filters.status }),
    ...rest,
    ...(view === "history" && { settledFrom }),
    excludePayroll: true,
  };
}

export function toSearchParams(
  params: Readonly<Record<string, string | boolean | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) search.set(name, String(value));
  }
  return search.toString();
}

/** The Nairobi day a settled bill was settled: paid, or cancelled; its due date otherwise. */
export function settledOn(bill: Bill): string {
  if (bill.paidOn) return bill.paidOn;
  if (bill.cancelledAt) return nairobiIsoDate(new Date(bill.cancelledAt));
  return bill.dueOn;
}

/** The date a row shows: when it's due, or on History when it was settled. */
export function rowDate(bill: Bill, view: BillListView): string {
  return view === "history" ? settledOn(bill) : bill.dueOn;
}

export type BillSortKey = "date" | "payee" | "amount" | "status";

export interface BillSort {
  readonly key: BillSortKey;
  readonly dir: "asc" | "desc";
}

/** To pay by urgency, Being paid by due date, History newest first. */
export const DEFAULT_BILL_SORT: Readonly<Record<BillListView, BillSort>> = {
  open: { key: "status", dir: "asc" },
  paying: { key: "date", dir: "asc" },
  history: { key: "date", dir: "desc" },
};

/** The direction a column starts in: dates soonest (History newest), amounts largest. */
export function firstSortDir(
  key: BillSortKey,
  view: BillListView,
): "asc" | "desc" {
  if (key === "amount") return "desc";
  if (key === "date" && view === "history") return "desc";
  return "asc";
}

const URGENCY: Readonly<Record<BillStatus, number>> = {
  payout_failed: 0,
  overdue: 1,
  due: 2,
  upcoming: 3,
  paying: 4,
  paid: 5,
  paid_outside: 6,
  paid_by_card: 7,
  cancelled: 8,
};

/** A bill's amount in KES cents, a USD one at today's rate; -1 while it has none. */
function kesValue(bill: Bill, rate: string | null): bigint {
  const stored = storedAmount(bill);
  if (stored === null) return -1n;
  if (bill.currency === "kes") return BigInt(stored);
  return BigInt(usdcToKesCents(stored, rate ?? "0") ?? "0");
}

const sign = (difference: bigint): number =>
  difference > 0n ? 1 : difference < 0n ? -1 : 0;

/** One flat list in the chosen order; ties fall back to the date, then the payee. */
export function sortBills(
  bills: readonly Bill[],
  view: BillListView,
  sort: BillSort,
  rate: string | null,
): Bill[] {
  const compare = (a: Bill, b: Bill): number => {
    const byDate = rowDate(a, view).localeCompare(rowDate(b, view));
    const primary =
      sort.key === "status"
        ? URGENCY[a.status] - URGENCY[b.status]
        : sort.key === "date"
          ? byDate
          : sort.key === "payee"
            ? a.payee.name.localeCompare(b.payee.name)
            : sign(kesValue(a, rate) - kesValue(b, rate));
    const ordered = sort.dir === "asc" ? primary : -primary;
    return (
      ordered ||
      byDate ||
      a.payee.name.localeCompare(b.payee.name) ||
      a.id.localeCompare(b.id)
    );
  };
  return [...bills].sort(compare);
}

export interface DueHint {
  readonly text: string;
  readonly tone: "late" | "today" | "soon";
}

/** "5 days late", "Today" or "In 3 days" under an unpaid bill's due date; nothing past two weeks. */
export function dueHint(
  bill: Pick<Bill, "status" | "dueOn">,
  today: string,
): DueHint | null {
  if (!isUnpaid(bill.status)) return null;
  const days = daysBetween(today, bill.dueOn);
  const plural = (n: number) => `${String(n)} ${n === 1 ? "day" : "days"}`;
  if (days < 0) return { text: `${plural(-days)} late`, tone: "late" };
  if (days === 0) return { text: "Today", tone: "today" };
  if (days <= 14) return { text: `In ${plural(days)}`, tone: "soon" };
  return null;
}
