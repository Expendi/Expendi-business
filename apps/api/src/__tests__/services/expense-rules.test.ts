import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

import {
  ageWarning,
  daysBetween,
  nairobiToday,
  NEEDS_EVIDENCE,
  readWarnings,
  requireEvidence,
} from "../../services/expenses/rules.js";

describe("daysBetween", () => {
  it.each([
    ["2026-11-02", "2026-11-02", 0],
    ["2026-09-03", "2026-11-02", 60],
    ["2026-09-02", "2026-11-02", 61],
    ["2025-12-31", "2026-01-01", 1],
    ["2024-02-28", "2024-03-01", 2],
  ])("counts %s to %s as %i days", (from, to, expected) => {
    // #when
    const days = daysBetween(from, to);

    // #then
    expect(days).toBe(expected);
  });
});

describe("ageWarning", () => {
  it("lets an expense exactly 60 days old through", () => {
    // #when
    const warning = ageWarning("2026-09-03", "2026-11-02");

    // #then
    expect(warning).toBeNull();
  });

  it("warns about an expense 61 days old", () => {
    // #when
    const warning = ageWarning("2026-09-02", "2026-11-02");

    // #then
    expect(warning).toEqual({
      code: "older_than_60_days",
      spentOn: "2026-09-02",
      ageDays: 61,
    });
  });

  it("counts across a year end", () => {
    // #when
    const warning = ageWarning("2025-11-01", "2026-01-01");

    // #then
    expect(warning).toMatchObject({ ageDays: 61 });
  });
});

describe("nairobiToday", () => {
  it("is already tomorrow in Nairobi at 21:30 UTC", () => {
    // #when
    const today = nairobiToday(new Date("2026-11-01T21:30:00Z"));

    // #then
    expect(today).toBe("2026-11-02");
  });

  it("is still today in Nairobi at 20:59 UTC", () => {
    // #when
    const today = nairobiToday(new Date("2026-11-01T20:59:00Z"));

    // #then
    expect(today).toBe("2026-11-01");
  });
});

describe("requireEvidence", () => {
  it("refuses an expense with no receipt, screenshot or SMS", () => {
    // #when
    const result = Effect.runSync(Effect.either(requireEvidence(0)));

    // #then
    expect(Either.isLeft(result) && result.left.message).toBe(NEEDS_EVIDENCE);
  });

  it("accepts one piece of evidence", () => {
    // #when
    const result = Effect.runSync(Effect.either(requireEvidence(1)));

    // #then
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("readWarnings", () => {
  it("keeps well-formed warnings and drops anything else", () => {
    // #given
    const stored = [
      { code: "older_than_60_days", spentOn: "2026-09-02", ageDays: 61 },
      { code: "unknown" },
      "junk",
    ];

    // #when
    const warnings = readWarnings(stored);

    // #then
    expect(warnings).toEqual([
      { code: "older_than_60_days", spentOn: "2026-09-02", ageDays: 61 },
    ]);
  });
});
