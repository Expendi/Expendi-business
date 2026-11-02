import { describe, expect, it } from "vitest";

import { kesAmountSchema, parseKesToCents } from "@expendi-business/shared";

describe("parseKesToCents", () => {
  it.each([
    ["1,500.50", 150_050n],
    ["1500", 150_000n],
    ["0.5", 50n],
    ["0.05", 5n],
    ["12.3", 1_230n],
    ["1,234,567.89", 123_456_789n],
    [" 250 ", 25_000n],
    ["0", 0n],
    ["90071992547409.93", 9_007_199_254_740_993n],
  ])("parses %j as %s cents", (input, cents) => {
    expect(parseKesToCents(input)).toBe(cents);
  });

  it.each([
    "-5",
    "-0.5",
    "1.234",
    "1,50",
    "1,5000",
    "12,34.5",
    ".5",
    "5.",
    "1e3",
    "KES 100",
    "abc",
    "",
    "1 000",
    "+5",
    "0x10",
  ])("refuses %j", (input) => {
    expect(parseKesToCents(input)).toBeNull();
  });
});

describe("kesAmountSchema", () => {
  it("gives cents for a typed amount", () => {
    expect(kesAmountSchema.parse("1,500.50")).toBe(150_050n);
  });

  it.each([
    ["0", "Enter an amount above zero."],
    ["-1", "Enter the amount in KES, like 1,500 or 1500.50."],
    ["100,000,000.01", "That amount is too large. Check it and try again."],
  ])("refuses %j", (input, message) => {
    const parsed = kesAmountSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });
});
