import { describe, expect, it } from "vitest";

import {
  dayCount,
  daysBetween,
  formatDayMonth,
  formatShortDate,
} from "./dates";

describe("formatShortDate", () => {
  it("names the weekday and leaves out this year", () => {
    // #given
    const today = "2026-11-11";

    // #when
    const label = formatShortDate("2026-11-09", today);

    // #then
    expect(label).toBe("Mon 9 Nov");
  });

  it("adds the year when it isn't this year", () => {
    // #when
    const label = formatShortDate("2025-12-28", "2026-01-02");

    // #then
    expect(label).toBe("Sun 28 Dec 2025");
  });

  it("shows anything that isn't a date as it is", () => {
    // #when
    const label = formatShortDate("soon", "2026-11-11");

    // #then
    expect(label).toBe("soon");
  });
});

describe("formatDayMonth", () => {
  it("writes the day and short month", () => {
    // #when
    const label = formatDayMonth("2026-12-10");

    // #then
    expect(label).toBe("10 Dec");
  });
});

describe("daysBetween", () => {
  it.each([
    ["2026-11-09", "2026-11-11", 2],
    ["2026-11-11", "2026-11-11", 0],
    ["2026-11-30", "2026-12-01", 1],
    ["2026-11-11", "2026-11-09", -2],
  ])("from %s to %s is %d", (from, to, expected) => {
    // #when
    const days = daysBetween(from, to);

    // #then
    expect(days).toBe(expected);
  });

  it("is null for anything that isn't a date", () => {
    // #when
    const days = daysBetween("2026-11-09", "later");

    // #then
    expect(days).toBeNull();
  });
});

describe("dayCount", () => {
  it.each([
    [1, "1 day"],
    [2, "2 days"],
  ])("counts %d as %s", (days, expected) => {
    // #when
    const label = dayCount(days);

    // #then
    expect(label).toBe(expected);
  });
});
