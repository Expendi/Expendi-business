import { describe, expect, it } from "vitest";

import { formatKesCents, formatUsdc } from "./money";

describe("formatUsdc", () => {
  it.each([
    ["0", "0.00"],
    ["1", "0.000001"],
    ["10000", "0.01"],
    ["1500000", "1.50"],
    ["1234567", "1.234567"],
    ["1234500000", "1,234.50"],
    ["1000000000000000", "1,000,000,000.00"],
    ["-2500000", "-2.50"],
    ["-0", "0.00"],
  ])("formats %s base units as %s", (baseUnits, expected) => {
    // #when
    const formatted = formatUsdc(baseUnits);

    // #then
    expect(formatted).toBe(expected);
  });

  it("keeps every digit of amounts beyond Number.MAX_SAFE_INTEGER", () => {
    // #given
    const baseUnits = "9007199254740993123456";

    // #when
    const formatted = formatUsdc(baseUnits);

    // #then
    expect(formatted).toBe("9,007,199,254,740,993.123456");
  });

  it.each(["1.5", "", "1e6", " 100"])(
    "refuses %j because it isn't an integer string",
    (baseUnits) => {
      // #then
      expect(() => formatUsdc(baseUnits)).toThrow();
    },
  );
});

describe("formatKesCents", () => {
  it.each([
    ["0", "0.00"],
    ["5", "0.05"],
    ["100", "1.00"],
    ["16012345", "160,123.45"],
  ])("formats %s cents as %s", (cents, expected) => {
    // #when
    const formatted = formatKesCents(cents);

    // #then
    expect(formatted).toBe(expected);
  });
});
