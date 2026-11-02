import type { RecurringSchedule } from "@expendi-business/shared";

/**
 * When a recurring payment falls due (spec §6.20). Dates are plain
 * `YYYY-MM-DD` calendar days with no time zone; "today" is the caller's
 * Nairobi date (`nairobiDate`).
 *
 * - weekly: every week on `scheduleDay`, an ISO weekday (1 is Monday).
 * - monthly, quarterly, yearly: every 1, 3 or 12 months, counted from
 *   `startsOn`'s month, on day `scheduleDay` of the month, or the month's
 *   last day when it's shorter. Each due date is worked out from the start,
 *   never from the one before, so a short month doesn't pull the rest
 *   earlier: the 31st gives 31 Jan, 30 Apr, 31 Jul, 31 Oct.
 *
 * Nothing falls due before `startsOn` or after `endsOn`; a due date on
 * either day counts.
 */
export interface Schedule {
  readonly schedule: RecurringSchedule;
  readonly scheduleDay: number;
  readonly startsOn: string;
  readonly endsOn: string | null;
}

const MONTHS_APART: Record<Exclude<RecurringSchedule, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

const DAY_MS = 86_400_000;

function toUtc(isoDate: string): Date {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const toIso = (date: Date): string => date.toISOString().slice(0, 10);

/** Months since year 0, so stepping by months is plain addition. */
function monthNumber(isoDate: string): number {
  const date = toUtc(isoDate);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Day `day` of the month, or its last day when the month is shorter. */
function dayOfMonth(month: number, day: number): string {
  const year = Math.floor(month / 12);
  const monthOfYear = month % 12;
  const lastDay = new Date(Date.UTC(year, monthOfYear + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(year, monthOfYear, Math.min(day, lastDay))));
}

function weeklyOnOrAfter(weekday: number, from: string): string {
  const date = toUtc(from);
  const isoWeekday = ((date.getUTCDay() + 6) % 7) + 1;
  const ahead = (weekday - isoWeekday + 7) % 7;
  return toIso(new Date(date.getTime() + ahead * DAY_MS));
}

function monthlyOnOrAfter(
  monthsApart: number,
  day: number,
  startsOn: string,
  from: string,
): string {
  const first = monthNumber(startsOn);
  const cycles = Math.ceil((monthNumber(from) - first) / monthsApart);
  const due = dayOfMonth(first + cycles * monthsApart, day);
  return due >= from
    ? due
    : dayOfMonth(first + (cycles + 1) * monthsApart, day);
}

/** The first due date on or after `from`; null when the schedule ends before it. */
export function dueOnOrAfter(schedule: Schedule, from: string): string | null {
  const start = from > schedule.startsOn ? from : schedule.startsOn;
  const due =
    schedule.schedule === "weekly"
      ? weeklyOnOrAfter(schedule.scheduleDay, start)
      : monthlyOnOrAfter(
          MONTHS_APART[schedule.schedule],
          schedule.scheduleDay,
          schedule.startsOn,
          start,
        );
  return schedule.endsOn !== null && due > schedule.endsOn ? null : due;
}

/** The schedule's first due date; null when none falls before its end. */
export function firstDueOn(schedule: Schedule): string | null {
  return dueOnOrAfter(schedule, schedule.startsOn);
}

/** The due date after `dueOn`; null when the schedule has ended by then. */
export function dueAfter(schedule: Schedule, dueOn: string): string | null {
  return dueOnOrAfter(
    schedule,
    toIso(new Date(toUtc(dueOn).getTime() + DAY_MS)),
  );
}
