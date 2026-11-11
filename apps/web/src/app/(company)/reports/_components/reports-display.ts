import type {
  ExportFile,
  ExportSummary,
  LargestPayment,
  MoneyOutKind,
  ReportFormat,
  ReportMonthSummary,
  ReportSpending,
  SpendingByHeading,
} from "@expendi-business/shared";
import {
  OVERVIEW_HEADING_LABELS,
  reportMonthSchema,
} from "@expendi-business/shared";

import type { SpendingRange } from "./reports-api";
import type { SortState } from "~/components/data/data-table";
import { kesValue } from "~/lib/chart-scale";
import { dayMonthLabel, monthName, shiftMonth } from "./report-month";

export const DOWNLOADS: readonly {
  readonly format: ReportFormat;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    format: "workbook",
    title: "Export (Excel)",
    detail:
      "All money out, bills outstanding at month end and float transfers, a sheet each.",
  },
  {
    format: "csv",
    title: "Export (CSV files)",
    detail: "The same sheets as UTF-8 CSV files, in a zip.",
  },
  {
    format: "receipts",
    title: "Receipts (zip)",
    detail: "Every receipt, named to match the export's receipt file column.",
  },
  {
    format: "etims",
    title: "eTIMS report (CSV)",
    detail:
      "Each expense bought in the month, with its eTIMS status, invoice number and supplier PIN.",
  },
];

export const REPORT_FORMATS_SHOWN = DOWNLOADS.map(({ format }) => format);

export function isReportFormat(value: string | null): value is ReportFormat {
  return REPORT_FORMATS_SHOWN.some((format) => format === value);
}

/** The files a shared export keeps, as its links name them. */
export const EXPORT_FILE_LABELS: Record<ExportFile, string> = {
  workbook: "Spreadsheet (Excel)",
  csv: "Spreadsheet (CSV files)",
  receipts: "Receipts (zip)",
};

/** The export's columns, as `apps/api/src/services/export/render.ts` writes them. */
export const MONEY_OUT_COLUMNS = [
  "Date",
  "Kind",
  "Overview heading",
  "Payee or employee",
  "Merchant",
  "Category",
  "Amount (KES)",
  "Status",
  "Source",
  "Approved by",
  "Self-approved",
  "M-Pesa code",
  "eTIMS invoice number",
  "eTIMS status",
  "Receipt file",
  "Payout reference",
] as const;

export const OUTSTANDING_COLUMNS = [
  "Due date",
  "Payee",
  "Overview heading",
  "Category",
  "Amount (KES)",
  "Amount (USD)",
  "Status at month end",
  "Reference",
] as const;

export const ETIMS_COLUMNS = [
  "Date",
  "Merchant",
  "Amount (KES)",
  "eTIMS status",
  "Invoice number",
  "Supplier PIN",
] as const;

/** The workbook's sheets, then the CSV zip's files, in the same order. */
export const EXPORT_PARTS = {
  workbook: ["Money out", "Outstanding bills", "Float transfers"],
  csv: ["money-out.csv", "outstanding-bills.csv", "float-transfers.csv"],
} as const;

/** The export's Kind column: a claim is a reimbursement wherever people read it. */
export const KIND_LABELS: Record<MoneyOutKind, string> = {
  claim: "Reimbursement",
  float: "Float",
  bill: "Bill",
  salary: "Salary",
  company: "Company",
};

export const FLOAT_TRANSFER_LABELS = {
  issue: "Float issued",
  top_up: "Float topped up",
} as const;

export const ETIMS_STATUS_LABELS = {
  attached: "Attached",
  none: "None",
  not_required: "Not required",
  "": "",
} as const;

export const HEADING_KEYS = [
  "petty_cash",
  "transactions",
  "salaries",
  "subscriptions",
] as const satisfies readonly (keyof SpendingByHeading)[];

export type HeadingKey = (typeof HEADING_KEYS)[number];

export function headingLabel(key: HeadingKey): string {
  return OVERVIEW_HEADING_LABELS[key];
}

export const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** The month in the URL, when it is a month this page can show. */
export function resolveMonth(
  param: string | null,
  thisMonth: string,
): string | null {
  return param !== null &&
    reportMonthSchema.safeParse(param).success &&
    param <= thisMonth
    ? param
    : null;
}

export function resolveRange(param: string | null): SpendingRange {
  return param === "12" ? 12 : 6;
}

export interface ChangeContext {
  readonly month: string;
  readonly thisMonth: string;
  /** Today in Nairobi, `YYYY-MM-DD`. */
  readonly today: string;
}

/**
 * How a month compares with the one before: "Up 14% on September", "Same
 * as September", "Nothing in September", or "So far, to 6 Nov" while the
 * month isn't over.
 */
export function changeLine(
  current: number,
  previous: number,
  { month, thisMonth, today }: ChangeContext,
): string {
  const before = monthName(shiftMonth(month, -1));
  if (month === thisMonth) return `So far, to ${dayMonthLabel(today)}`;
  if (previous <= 0) {
    return current > 0 ? `Nothing in ${before}` : `Nothing in ${before} either`;
  }
  const change = Math.round((current / previous - 1) * 100);
  if (change === 0) return `Same as ${before}`;
  return `${change > 0 ? "Up" : "Down"} ${String(Math.abs(change))}% on ${before}`;
}

/** A table's Change column: "+31%", "−9%", "Same", "New" or "None". */
export function deltaText(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? "New" : "None";
  const change = Math.round((current / previous - 1) * 100);
  if (change === 0) return "Same";
  return `${change > 0 ? "+" : "−"}${String(Math.abs(change))}%`;
}

/** Up by a fifth or more, which the tables make stand out. */
export function isNotableRise(current: number, previous: number): boolean {
  return previous > 0 && current / previous - 1 >= 0.2;
}

export function moneyOutSub(
  summary: ReportMonthSummary,
  change: string | null,
): string {
  const { rows } = summary.moneyOut;
  if (rows === 0) return `Nothing paid out in ${monthName(summary.month)}`;
  const payments = plural(rows, "payment", "payments");
  return change ? `${payments} · ${change}` : payments;
}

export function outstandingSub({ outstanding }: ReportMonthSummary): string {
  if (outstanding.rows === 0) return "None due by month end";
  const parts = [
    outstanding.overdue > 0 ? `${String(outstanding.overdue)} overdue` : null,
    outstanding.withoutAmount > 0
      ? `${String(outstanding.withoutAmount)} without an amount`
      : null,
  ].filter((part) => part !== null);
  const bills = plural(outstanding.rows, "bill", "bills");
  return parts.length ? `${bills} · ${parts.join(", ")}` : bills;
}

/** Every row came from the spreadsheet import, so there are no receipts or eTIMS details. */
export function isImportedMonth({ moneyOut }: ReportMonthSummary): boolean {
  return moneyOut.rows > 0 && moneyOut.importedRows === moneyOut.rows;
}

export function receiptsSub(summary: ReportMonthSummary): string {
  const { files, expensesWithout } = summary.receipts;
  if (files === 0 && expensesWithout === 0) {
    return isImportedMonth(summary)
      ? "Imported months have no receipts"
      : "No expenses this month";
  }
  if (expensesWithout > 0) {
    return `${plural(expensesWithout, "expense has", "expenses have")} none`;
  }
  return "Every expense has one";
}

export function etimsSub(summary: ReportMonthSummary): string {
  const { rows, none, notRequired } = summary.etims;
  if (rows === 0) {
    return isImportedMonth(summary)
      ? "Imported months have no eTIMS details"
      : "No expenses this month";
  }
  return `${String(none)} without one · ${String(notRequired)} not required`;
}

export type FactIcon = "sheet" | "archive" | "table" | "image";

/** What a download holds, as small markers under its name. */
export function fileFacts(
  format: ReportFormat,
  summary: ReportMonthSummary,
): readonly { readonly icon: FactIcon; readonly text: string }[] {
  const payments = plural(summary.moneyOut.rows, "payment", "payments");
  switch (format) {
    case "workbook":
      return [
        { icon: "sheet", text: "3 sheets" },
        { icon: "table", text: payments },
      ];
    case "csv":
      return [
        { icon: "archive", text: "3 files" },
        { icon: "table", text: payments },
      ];
    case "receipts":
      return [
        {
          icon: "image",
          text: plural(summary.receipts.files, "receipt", "receipts"),
        },
      ];
    case "etims":
      return [
        {
          icon: "table",
          text: plural(summary.etims.rows, "expense", "expenses"),
        },
      ];
  }
}

export interface SpendingMonthView {
  readonly month: string;
  readonly totalKes: string;
  readonly total: number;
  /** The month before's total, to compare with. */
  readonly previous: number;
  readonly payments: number;
  readonly headings: Record<HeadingKey, number>;
  readonly previousHeadings: Record<HeadingKey, number>;
  readonly headingsKes: SpendingByHeading;
}

function headingValues(
  headings: SpendingByHeading,
): Record<HeadingKey, number> {
  return {
    petty_cash: kesValue(headings.petty_cash),
    transactions: kesValue(headings.transactions),
    salaries: kesValue(headings.salaries),
    subscriptions: kesValue(headings.subscriptions),
  };
}

/** The months shown, oldest first, each with the month before it. */
export function spendingMonths(
  spending: ReportSpending,
): readonly SpendingMonthView[] {
  return spending.months.slice(1).map((month, index) => {
    const before = spending.months[index];
    return {
      month: month.month,
      totalKes: month.totalKes,
      total: kesValue(month.totalKes),
      previous: before ? kesValue(before.totalKes) : 0,
      payments: month.payments,
      headings: headingValues(month.headings),
      previousHeadings: before
        ? headingValues(before.headings)
        : headingValues({
            petty_cash: "0",
            transactions: "0",
            salaries: "0",
            subscriptions: "0",
          }),
      headingsKes: month.headings,
    };
  });
}

export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly currentKes: string;
  readonly previousKes: string;
  readonly current: number;
  readonly previous: number;
  readonly payments: number;
  readonly headingsKes: SpendingByHeading;
  /** The months shown, oldest first. */
  readonly trend: readonly number[];
}

/** Each category's chosen month against the month before, and its trend. */
export function categoryRows(spending: ReportSpending): CategoryRow[] {
  return spending.categories.map((category) => {
    const shown = category.months.slice(1);
    const current = category.months.at(-1);
    const previous = category.months.at(-2);
    return {
      id: category.id,
      name: category.name,
      currentKes: current?.totalKes ?? "0",
      previousKes: previous?.totalKes ?? "0",
      current: current ? kesValue(current.totalKes) : 0,
      previous: previous ? kesValue(previous.totalKes) : 0,
      payments: current?.payments ?? 0,
      headingsKes: current?.headings ?? {
        petty_cash: "0",
        transactions: "0",
        salaries: "0",
        subscriptions: "0",
      },
      trend: shown.map((month) => kesValue(month.totalKes)),
    };
  });
}

/** "Transactions and Petty cash": the headings it was spent under, largest first. */
export function headingSummary(headings: SpendingByHeading): string {
  return HEADING_KEYS.map((key) => ({ key, value: BigInt(headings[key]) }))
    .filter(({ value }) => value > 0n)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .map(({ key }) => headingLabel(key))
    .join(" and ");
}

export function categoryMeta(row: CategoryRow, month: string): string {
  return row.payments > 0
    ? `${headingSummary(row.headingsKes)} · ${plural(row.payments, "payment", "payments")}`
    : `Nothing in ${monthName(month)}`;
}

export type CategorySortKey = "name" | "previous" | "current" | "change";

export const CATEGORY_FIRST_DIRECTION: Record<CategorySortKey, "asc" | "desc"> =
  {
    name: "asc",
    previous: "desc",
    current: "desc",
    change: "desc",
  };

function changeRatio(row: CategoryRow): number {
  if (row.previous > 0) return row.current / row.previous - 1;
  return row.current > 0 ? Number.POSITIVE_INFINITY : 0;
}

export function sortCategories(
  rows: readonly CategoryRow[],
  { key, dir }: SortState<CategorySortKey>,
): CategoryRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary =
      key === "name"
        ? a.name.localeCompare(b.name)
        : key === "previous"
          ? a.previous - b.previous
          : key === "current"
            ? a.current - b.current
            : changeRatio(a) - changeRatio(b);
    return (
      sign * (Number.isNaN(primary) ? 0 : primary) ||
      b.current - a.current ||
      a.name.localeCompare(b.name)
    );
  });
}

/** A category's largest payments in the chosen month, largest first. */
export function largestFor(
  payments: readonly LargestPayment[],
  categoryId: string,
): LargestPayment[] {
  return payments
    .filter((payment) => payment.categoryId === categoryId)
    .sort((a, b) => {
      const difference = BigInt(b.amountKes) - BigInt(a.amountKes);
      return difference > 0n ? 1 : difference < 0n ? -1 : 0;
    });
}

/** "4 Nov 2026 · Reimbursement, Brian Otieno". */
export function paymentWho(payment: LargestPayment): string {
  const kind = KIND_LABELS[payment.kind];
  return (payment.kind === "claim" || payment.kind === "float") &&
    payment.personName
    ? `${kind}, ${payment.personName}`
    : kind;
}

export type ExportSortKey = "month" | "made" | "until";

export const EXPORT_FIRST_DIRECTION: Record<ExportSortKey, "asc" | "desc"> = {
  month: "desc",
  made: "desc",
  until: "desc",
};

export function sortExports(
  exports: readonly ExportSummary[],
  { key, dir }: SortState<ExportSortKey>,
): ExportSummary[] {
  const value = (exported: ExportSummary) =>
    key === "month"
      ? exported.month
      : key === "made"
        ? exported.createdAt
        : exported.expiresAt;
  const sign = dir === "asc" ? 1 : -1;
  return [...exports].sort(
    (a, b) =>
      sign * value(a).localeCompare(value(b)) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export function linksWork(exported: ExportSummary, now: Date): boolean {
  return new Date(exported.expiresAt).getTime() > now.getTime();
}

export function madeBy(exported: ExportSummary): string {
  return exported.monthly
    ? "Monthly email to accountants"
    : `Shared by ${exported.createdBy ?? "an admin"}`;
}
