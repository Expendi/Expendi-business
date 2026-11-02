import type { GeneratedExport } from "@expendi-business/shared";

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

/** The month it is in Nairobi, `YYYY-MM`: export months are Kenyan months (spec §6.24). */
export function nairobiMonth(at: Date): string {
  const parts = Object.fromEntries(
    NAIROBI_MONTH.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
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

/** e.g. "1 December 2026". */
export function expiryLabel(expiresAt: string): string {
  return DAY_LABEL.format(new Date(expiresAt));
}

/** What the admin shares with their accountant: the three links and when they stop working. */
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
