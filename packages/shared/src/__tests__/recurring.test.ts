import { describe, expect, it } from "vitest";

import {
  createRecurringItemRequestSchema,
  describeSchedule,
} from "../recurring.js";

describe("describeSchedule", () => {
  it.each([
    ["weekly", 1, "2026-11-02", "Every Monday"],
    ["weekly", 7, "2026-11-02", "Every Sunday"],
    ["monthly", 1, "2026-11-02", "Monthly on the 1st"],
    ["monthly", 22, "2026-11-02", "Monthly on the 22nd"],
    ["monthly", 13, "2026-11-02", "Monthly on the 13th"],
    ["monthly", 28, "2026-11-02", "Monthly on the 28th"],
    [
      "monthly",
      31,
      "2026-11-02",
      "Monthly on the 31st, or the month’s last day",
    ],
    [
      "quarterly",
      31,
      "2026-01-01",
      "Quarterly on the 31st of Jan, Apr, Jul and Oct, or the month’s last day",
    ],
    [
      "quarterly",
      20,
      "2026-11-01",
      "Quarterly on the 20th of Feb, May, Aug and Nov",
    ],
    ["yearly", 29, "2028-02-29", "Yearly on the last day of February"],
    ["yearly", 31, "2026-04-01", "Yearly on 30 April"],
    ["yearly", 25, "2026-12-01", "Yearly on 25 December"],
  ] as const)(
    "%s on day %i from %s reads “%s”",
    (schedule, day, startsOn, words) => {
      // #then
      expect(describeSchedule(schedule, day, startsOn)).toBe(words);
    },
  );
});

describe("createRecurringItemRequestSchema", () => {
  const valid = {
    payeeId: "11111111-1111-4111-8111-111111111111",
    categoryId: "22222222-2222-4222-8222-222222222222",
    amountKes: "15,000",
    schedule: "monthly",
    scheduleDay: 31,
    startsOn: "2026-11-02",
  } as const;

  it("parses the amount into cents and fills in the defaults", () => {
    // #when
    const parsed = createRecurringItemRequestSchema.parse(valid);

    // #then
    expect(parsed).toMatchObject({
      amountKes: 1_500_000n,
      variable: false,
      payVia: "expendi",
      reminderDays: 3,
    });
  });

  it.each([
    ["a weekday past 7", { schedule: "weekly", scheduleDay: 8 }],
    ["an end before the start", { endsOn: "2026-11-01" }],
    ["a variable amount", { variable: true }],
    ["no amount on a fixed payment", { amountKes: null }],
  ] as const)("refuses %s", (_case, overrides) => {
    // #then
    expect(
      createRecurringItemRequestSchema.safeParse({ ...valid, ...overrides })
        .success,
    ).toBe(false);
  });
});
