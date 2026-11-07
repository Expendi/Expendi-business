import { nairobiDate } from "../bills/status.js";

/**
 * A Nairobi calendar month (spec §6.24): its first day and the first day
 * after it, as dates and as instants. Kenya has no daylight saving, so
 * midnight is always 21:00 UTC the day before.
 */
export interface MonthBounds {
  readonly start: string;
  readonly end: string;
  readonly lastDay: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

const atNairobiMidnight = (date: string): Date =>
  new Date(`${date}T00:00:00+03:00`);

export function shiftMonth(month: string, by: number): string {
  const [year = 0, monthNumber = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + by, 1))
    .toISOString()
    .slice(0, 7);
}

export function monthBounds(month: string): MonthBounds {
  const start = `${month}-01`;
  const end = `${shiftMonth(month, 1)}-01`;
  const startAt = atNairobiMidnight(start);
  const endAt = atNairobiMidnight(end);
  const lastDay = nairobiDate(new Date(endAt.getTime() - 1));
  return { start, end, lastDay, startAt, endAt };
}

export const nairobiMonth = (at: Date): string => nairobiDate(at).slice(0, 7);

export const previousMonth = (month: string): string => shiftMonth(month, -1);
