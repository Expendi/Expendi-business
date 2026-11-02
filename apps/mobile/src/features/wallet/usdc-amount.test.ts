import { describe, expect, it } from "vitest";

import { compareBaseUnits, parseUsdcAmount, shortAddress } from "./usdc-amount";

const PLENTY = "1000000000000000";

describe("parseUsdcAmount", () => {
  it.each([
    ["12.5", "12500000"],
    ["12,5", "12500000"],
    ["0.000001", "1"],
    ["1", "1000000"],
    ["007.10", "7100000"],
    [" 3. ", "3000000"],
    [".5", "500000"],
    ["1000000.123456", "1000000123456"],
  ])("reads %j as %s base units", (input, baseUnits) => {
    // #when
    const result = parseUsdcAmount(input, PLENTY);

    // #then
    expect(result).toEqual({ ok: true, baseUnits });
  });

  it("keeps every digit of an amount beyond Number.MAX_SAFE_INTEGER", () => {
    // #when
    const result = parseUsdcAmount("9007199254.740993", "9007199254740993");

    // #then
    expect(result).toEqual({ ok: true, baseUnits: "9007199254740993" });
  });

  it.each(["", ".", "abc", "1.2.3", "-1", "1e6", "0x10"])(
    "refuses %j because it isn't an amount",
    (input) => {
      // #when
      const result = parseUsdcAmount(input, PLENTY);

      // #then
      expect(result).toEqual({ ok: false, error: "Enter an amount in USDC." });
    },
  );

  it("refuses more than 6 decimals rather than rounding", () => {
    // #when
    const result = parseUsdcAmount("1.0000001", PLENTY);

    // #then
    expect(result).toEqual({
      ok: false,
      error: "USDC has at most 6 decimal places.",
    });
  });

  it.each(["0", "0.000000", "000"])("refuses zero (%j)", (input) => {
    // #when
    const result = parseUsdcAmount(input, PLENTY);

    // #then
    expect(result).toEqual({ ok: false, error: "Enter an amount above zero." });
  });

  it("allows exactly the balance", () => {
    // #when
    const result = parseUsdcAmount("20.000001", "20000001");

    // #then
    expect(result).toEqual({ ok: true, baseUnits: "20000001" });
  });

  it("refuses one base unit more than the balance", () => {
    // #when
    const result = parseUsdcAmount("20.000002", "20000001");

    // #then
    expect(result).toEqual({
      ok: false,
      error: "That's more than the wallet holds.",
    });
  });
});

describe("compareBaseUnits", () => {
  it.each([
    ["1", "2", -1],
    ["10", "9", 1],
    ["0010", "10", 0],
    ["999999", "1000000", -1],
    ["12345678901234567890", "12345678901234567891", -1],
  ] as const)("compares %s with %s as %d", (a, b, expected) => {
    // #when
    const result = compareBaseUnits(a, b);

    // #then
    expect(result).toBe(expected);
  });
});

describe("shortAddress", () => {
  it("keeps the start and end of an address", () => {
    // #when
    const short = shortAddress("0x1234567890abcdef1234567890abcdef12345678");

    // #then
    expect(short).toBe("0x1234…5678");
  });
});
