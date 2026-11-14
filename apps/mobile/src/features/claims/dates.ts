const MONTHS = [
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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The phone's calendar day as `YYYY-MM-DD`, the format claims store. */
export function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `2026-10-15` → `15 Oct 2026`; anything else is shown as it is. */
export function formatIsoDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return isoDate;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function parseIsoDate(isoDate: string): Date | null {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return null;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

/**
 * `2026-11-09` → `Mon 9 Nov`, with the year added when it isn't `today`'s
 * year; anything else is shown as it is.
 */
export function formatShortDate(isoDate: string, today: string): string {
  const date = parseIsoDate(isoDate);
  if (!date) return isoDate;
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "";
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const year = today.slice(0, 4) === isoDate.slice(0, 4) ? "" : ` ${isoDate.slice(0, 4)}`;
  return `${weekday} ${String(date.getUTCDate())} ${month}${year}`;
}

/** `2026-12-10` → `10 Dec`; anything else is shown as it is. */
export function formatDayMonth(isoDate: string): string {
  const date = parseIsoDate(isoDate);
  if (!date) return isoDate;
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** Whole calendar days from `from` to `to`; null when either isn't `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number | null {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** `3` → `3 days`, `1` → `1 day`. */
export function dayCount(days: number): string {
  return `${String(days)} ${days === 1 ? "day" : "days"}`;
}
