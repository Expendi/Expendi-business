import { describe, expect, it } from "vitest";

import type { Schedule } from "../../services/recurring/schedule.js";
import {
  dueAfter,
  dueOnOrAfter,
  firstDueOn,
} from "../../services/recurring/schedule.js";

function schedule(
  frequency: Schedule["schedule"],
  scheduleDay: number,
  startsOn: string,
  endsOn: string | null = null,
): Schedule {
  return { schedule: frequency, scheduleDay, startsOn, endsOn };
}

/** The first `count` due dates, or fewer if the schedule ends. */
function dueDates(of: Schedule, count: number): string[] {
  const dates: string[] = [];
  let next = firstDueOn(of);
  while (next !== null && dates.length < count) {
    dates.push(next);
    next = dueAfter(of, next);
  }
  return dates;
}

describe("monthly", () => {
  it("on the 31st falls on the last day of shorter months, and back on the 31st after", () => {
    // #given
    const rent = schedule("monthly", 31, "2026-01-01");

    // #then
    expect(dueDates(rent, 13)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
    ]);
  });

  it.each([
    [29, "2026-02-28", "2026-03-29"],
    [30, "2026-02-28", "2026-03-30"],
    [31, "2026-02-28", "2026-03-31"],
  ])(
    "on day %i lands on 28 Feb in 2026 and returns to its day in March",
    (day, february, march) => {
      // #given
      const monthly = schedule("monthly", day, "2026-02-01");

      // #then
      expect(dueDates(monthly, 2)).toEqual([february, march]);
    },
  );

  it.each([
    [29, "2028-02-29"],
    [30, "2028-02-29"],
    [31, "2028-02-29"],
    [28, "2028-02-28"],
  ])("on day %i lands on %s in the leap year 2028", (day, february) => {
    // #given
    const monthly = schedule("monthly", day, "2028-02-01");

    // #then
    expect(firstDueOn(monthly)).toBe(february);
  });

  it("treats 2100 as a common year (divisible by 100, not by 400) and 2000 as a leap year", () => {
    // #then
    expect(firstDueOn(schedule("monthly", 29, "2100-02-01"))).toBe(
      "2100-02-28",
    );
    expect(firstDueOn(schedule("monthly", 29, "2000-02-01"))).toBe(
      "2000-02-29",
    );
  });

  it("crosses the year end", () => {
    // #given
    const monthly = schedule("monthly", 31, "2026-12-31");

    // #then
    expect(dueDates(monthly, 3)).toEqual([
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
  });

  it("starts on the first due day on or after the start date", () => {
    // #then
    expect(firstDueOn(schedule("monthly", 10, "2026-01-15"))).toBe(
      "2026-02-10",
    );
    expect(firstDueOn(schedule("monthly", 15, "2026-01-15"))).toBe(
      "2026-01-15",
    );
    expect(firstDueOn(schedule("monthly", 1, "2026-12-02"))).toBe("2027-01-01");
  });
});

describe("quarterly", () => {
  it("counts every 3 months from the start month without drifting after a short month", () => {
    // #given
    const vat = schedule("quarterly", 31, "2026-01-01");

    // #then
    expect(dueDates(vat, 5)).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
      "2027-01-31",
    ]);
  });

  it("goes through February, in a leap year and out of it, across the year end", () => {
    // #given
    const quarterly = schedule("quarterly", 31, "2027-11-01");

    // #then
    expect(dueDates(quarterly, 6)).toEqual([
      "2027-11-30",
      "2028-02-29",
      "2028-05-31",
      "2028-08-31",
      "2028-11-30",
      "2029-02-28",
    ]);
  });

  it("skips to the next quarter when the start date is past that month's day", () => {
    // #then
    expect(firstDueOn(schedule("quarterly", 10, "2026-01-15"))).toBe(
      "2026-04-10",
    );
  });
});

describe("yearly", () => {
  it("on 29 Feb falls on 28 Feb in common years and returns to 29 Feb in leap years", () => {
    // #given
    const yearly = schedule("yearly", 29, "2028-02-29");

    // #then
    expect(dueDates(yearly, 5)).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("keeps 2100 a common year", () => {
    // #given
    const yearly = schedule("yearly", 29, "2096-02-01");

    // #then
    expect(dueDates(yearly, 6)).toEqual([
      "2096-02-29",
      "2097-02-28",
      "2098-02-28",
      "2099-02-28",
      "2100-02-28",
      "2101-02-28",
    ]);
  });

  it("counts from the start month and waits a year when the start is past its day", () => {
    // #then
    expect(dueDates(schedule("yearly", 31, "2026-04-01"), 2)).toEqual([
      "2026-04-30",
      "2027-04-30",
    ]);
    expect(firstDueOn(schedule("yearly", 10, "2026-01-15"))).toBe("2027-01-10");
  });

  it("falls on 31 Dec and then the next 31 Dec", () => {
    // #then
    expect(dueDates(schedule("yearly", 31, "2026-12-31"), 2)).toEqual([
      "2026-12-31",
      "2027-12-31",
    ]);
  });
});

describe("weekly", () => {
  it("falls on the ISO weekday, Monday being 1", () => {
    // #given 2026-11-02 is a Monday
    const weekly = schedule("weekly", 1, "2026-11-02");

    // #then
    expect(dueDates(weekly, 3)).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
  });

  it("waits for the weekday after the start, Sunday being 7", () => {
    // #then
    expect(firstDueOn(schedule("weekly", 7, "2026-11-02"))).toBe("2026-11-08");
    expect(firstDueOn(schedule("weekly", 4, "2026-11-06"))).toBe("2026-11-12");
  });

  it("crosses the year end and leap days", () => {
    // #then
    expect(dueDates(schedule("weekly", 4, "2026-12-31"), 2)).toEqual([
      "2026-12-31",
      "2027-01-07",
    ]);
    expect(dueDates(schedule("weekly", 2, "2028-02-22"), 3)).toEqual([
      "2028-02-22",
      "2028-02-29",
      "2028-03-07",
    ]);
  });
});

describe("start and end dates", () => {
  it("counts an end date exactly on a due date, and nothing after it", () => {
    // #given
    const lease = schedule("monthly", 30, "2026-01-01", "2026-04-30");

    // #then
    expect(dueDates(lease, 10)).toEqual([
      "2026-01-30",
      "2026-02-28",
      "2026-03-30",
      "2026-04-30",
    ]);
    expect(dueAfter(lease, "2026-04-30")).toBeNull();
  });

  it("stops before a due date the day after the end", () => {
    // #given
    const lease = schedule("monthly", 30, "2026-01-01", "2026-04-29");

    // #then
    expect(dueDates(lease, 10)).toEqual([
      "2026-01-30",
      "2026-02-28",
      "2026-03-30",
    ]);
  });

  it("has no due date when none falls between the start and the end", () => {
    // #then
    expect(
      firstDueOn(schedule("monthly", 31, "2026-04-01", "2026-04-29")),
    ).toBeNull();
    expect(
      firstDueOn(schedule("quarterly", 1, "2026-01-02", "2026-03-31")),
    ).toBeNull();
  });

  it("counts a start date that is a due date", () => {
    // #then
    expect(firstDueOn(schedule("weekly", 1, "2026-11-02", "2026-11-02"))).toBe(
      "2026-11-02",
    );
  });

  it("never falls before the start, even when asked from an earlier day", () => {
    // #then
    expect(
      dueOnOrAfter(schedule("monthly", 5, "2026-06-01"), "2026-01-01"),
    ).toBe("2026-06-05");
  });

  it("finds the due date on or after a later day, counting from the start month", () => {
    // #given
    const quarterly = schedule("quarterly", 15, "2026-01-01");

    // #then
    expect(dueOnOrAfter(quarterly, "2026-04-15")).toBe("2026-04-15");
    expect(dueOnOrAfter(quarterly, "2026-04-16")).toBe("2026-07-15");
    expect(dueOnOrAfter(quarterly, "2026-05-01")).toBe("2026-07-15");
  });
});
