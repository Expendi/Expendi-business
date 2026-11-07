import type { z } from "zod";

import type {
  EtimsStatus,
  ExpenseListKind,
  ExpenseSortKey,
  ExpenseStatus,
  ExpenseSummaryQuery,
} from "@expendi-business/shared";
import { expenseListQuerySchema } from "@expendi-business/shared";

import type { SortDirection, SortState } from "~/components/data/table";

/**
 * The Expenses filters (spec §6.14), kept in the page's URL so other pages
 * can link to them, e.g. `?membershipId=…`, `?kind=petty_cash` or
 * `?noReceipt=1`.
 */
export interface ExpenseFilters {
  membershipId?: string;
  kind?: ExpenseListKind;
  categoryId?: string;
  /** `YYYY-MM`, by purchase date. */
  month?: string;
  etimsStatus?: EtimsStatus;
  status?: ExpenseStatus;
  /** true: only those with no receipt; false: only those with one. */
  noReceipt?: boolean;
}

const FILTER_NAMES = [
  "membershipId",
  "kind",
  "categoryId",
  "month",
  "etimsStatus",
  "status",
  "noReceipt",
] as const satisfies readonly (keyof ExpenseFilters)[];

function valid<T>(schema: z.ZodType<T>, raw: string | null): T | undefined {
  const parsed = schema.safeParse(raw === null || raw === "" ? undefined : raw);
  return parsed.success ? parsed.data : undefined;
}

function readNoReceipt(raw: string | null): boolean | undefined {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

/** A value that isn't valid is dropped, not sent. */
export function filtersFromParams(params: {
  get: (name: string) => string | null;
}): ExpenseFilters {
  const { shape } = expenseListQuerySchema;
  return {
    membershipId: valid(shape.membershipId, params.get("membershipId")),
    kind: valid(shape.kind, params.get("kind")),
    categoryId: valid(shape.categoryId, params.get("categoryId")),
    month: valid(shape.month, params.get("month")),
    etimsStatus: valid(shape.etimsStatus, params.get("etimsStatus")),
    status: valid(shape.status, params.get("status")),
    noReceipt: readNoReceipt(params.get("noReceipt")),
  };
}

export function filtersToParams(filters: ExpenseFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = filters[name];
    if (value === undefined || value === "") continue;
    params.set(name, typeof value === "boolean" ? (value ? "1" : "0") : value);
  }
  return params;
}

/** The filters as `GET …/expenses` and `…/expenses/summary` take them. */
export function toApiQuery(filters: ExpenseFilters): ExpenseSummaryQuery {
  const query: ExpenseSummaryQuery = {};
  if (filters.membershipId) query.membershipId = filters.membershipId;
  if (filters.kind) query.kind = filters.kind;
  if (filters.categoryId) query.categoryId = filters.categoryId;
  if (filters.month) query.month = filters.month;
  if (filters.etimsStatus) query.etimsStatus = filters.etimsStatus;
  if (filters.status) query.status = filters.status;
  if (filters.noReceipt !== undefined) {
    query.noReceipt = filters.noReceipt ? "true" : "false";
  }
  return query;
}

/** Whether a chip filter is set; the kind is a tab, not a chip. */
export function hasChipFilters(filters: ExpenseFilters): boolean {
  return FILTER_NAMES.some(
    (name) => name !== "kind" && filters[name] !== undefined,
  );
}

export const DEFAULT_SORT: SortState<ExpenseSortKey> = {
  key: "date",
  dir: "desc",
};

/** A column's first direction: newest, biggest and most urgent first. */
export const FIRST_DIRECTION: Record<ExpenseSortKey, SortDirection> = {
  date: "desc",
  person: "asc",
  merchant: "asc",
  amount: "desc",
  status: "asc",
};

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

/** "2026-11" → "November 2026". */
export function formatMonth(month: string): string {
  const [year, number] = month.split("-");
  const name = MONTH_NAMES[Number(number) - 1];
  return name && year ? `${name} ${year}` : month;
}

/** This month in Nairobi, where every date here is. */
export function nairobiMonth(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .slice(0, 7);
}

/** The last twelve months, newest first, plus the chosen one if older. */
export function monthChoices(
  current: string,
  chosen: string | undefined,
): string[] {
  const [year = 0, month = 1] = current.split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, back) =>
    new Date(Date.UTC(year, month - 1 - back, 1)).toISOString().slice(0, 7),
  );
  if (chosen && !months.includes(chosen)) months.push(chosen);
  return months;
}
