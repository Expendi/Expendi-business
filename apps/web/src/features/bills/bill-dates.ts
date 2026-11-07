/** How far back the History tab goes. */
export const HISTORY_DAYS = 180;

const DAY_MS = 86_400_000;

function toUtc(isoDate: string): number {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** `YYYY-MM-DD` moved by whole days, with calendar arithmetic only. */
export function shiftIsoDate(isoDate: string, days: number): string {
  return new Date(toUtc(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar day in Nairobi at `at`, as `YYYY-MM-DD`. */
export function nairobiIsoDate(at: Date): string {
  return NAIROBI_DAY.format(at);
}
