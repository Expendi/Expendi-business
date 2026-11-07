import type { GeneratedExport } from "@expendi-business/shared";

/**
 * Copied from `apps/mobile/src/features/export/export-month.ts`: report
 * months are Nairobi months (spec §6.24), whatever the browser's time zone.
 */

const NAIROBI_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Africa/Nairobi",
});

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const NAIROBI_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Nairobi",
});

const MONTH_ABBRS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The day it is in Nairobi at `at`, `YYYY-MM-DD`. */
export function nairobiDay(at: Date): string {
  const parts = Object.fromEntries(
    NAIROBI_DAY.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
}

/** A calendar date or a moment, as its Nairobi day: "4 Nov 2026". */
export function dayLabel(isoDateOrTime: string): string {
  const day =
    isoDateOrTime.length > 10
      ? nairobiDay(new Date(isoDateOrTime))
      : isoDateOrTime;
  const [year = "", month = "", date = ""] = day.split("-");
  return `${String(Number(date))} ${MONTH_ABBRS[Number(month) - 1] ?? ""} ${year}`;
}

/** e.g. "2026-11-06" → "6 Nov". */
export function dayMonthLabel(isoDate: string): string {
  const [, month = "", date = ""] = isoDate.split("-");
  return `${String(Number(date))} ${MONTH_ABBRS[Number(month) - 1] ?? ""}`;
}

/** A moment's Nairobi time, "09:00". */
export function nairobiTime(isoDateTime: string): string {
  return NAIROBI_TIME.format(new Date(isoDateTime));
}

/** The month it is in Nairobi at `at`, `YYYY-MM`. */
export function nairobiMonth(at: Date): string {
  const parts = Object.fromEntries(
    NAIROBI_MONTH.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.year ?? ""}-${parts.month ?? ""}`;
}

export function shiftMonth(month: string, by: number): string {
  const [year = 0, monthNumber = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + by, 1))
    .toISOString()
    .slice(0, 7);
}

/** e.g. "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
}

const MONTH_NAME = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "UTC",
});

/** e.g. "2026-10" → "October". */
export function monthName(month: string): string {
  return MONTH_NAME.format(new Date(`${month}-01T00:00:00Z`));
}

/** e.g. "2026-09" → "Sep". */
export function monthAbbr(month: string): string {
  return MONTH_ABBRS[Number(month.slice(5, 7)) - 1] ?? month;
}

/** The `count` months up to and including `month`, oldest first. */
export function monthsEnding(month: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    shiftMonth(month, index - count + 1),
  );
}

/** e.g. "1 December 2026". */
export function expiryLabel(expiresAt: string): string {
  return DAY_LABEL.format(new Date(expiresAt));
}

/** What an admin shares with their accountant: the three links and when they stop working. */
export function shareMessage(
  companyName: string,
  exported: GeneratedExport,
): string {
  return [
    `${companyName}: ${monthLabel(exported.month)} export`,
    `Spreadsheet (Excel): ${exported.links.workbook}`,
    `Spreadsheet (CSV files): ${exported.links.csv}`,
    `Receipts (zip): ${exported.links.receipts}`,
    `These links work until ${expiryLabel(exported.expiresAt)}.`,
  ].join("\n\n");
}
