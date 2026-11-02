import { describe, expect, it } from "vitest";

import { importAmount, importDate } from "../../services/import/parse.js";

describe("spreadsheet values", () => {
  it("parses KES with integer arithmetic", () => {
    expect(importAmount("1,500.50")).toBe(150050n);
    expect(importAmount("90071992547409.93")).toBe(9007199254740993n);
    expect(importAmount("0", true)).toBe(0n);
  });
  it.each(["1,50", "1e3", "-1", "0", "12.345", "92233720368547758.08"])(
    "refuses ambiguous/out-of-range money: %s",
    (value) => expect(() => importAmount(value)).toThrow(),
  );
  it("uses day-first dates and validates actual calendar days", () => {
    expect(importDate("02/11/2026")).toBe("2026-11-02");
    expect(importDate("29/02/2024")).toBe("2024-02-29");
    expect(() => importDate("29/02/2026")).toThrow();
    expect(() => importDate("01/02/26")).toThrow();
  });
});
