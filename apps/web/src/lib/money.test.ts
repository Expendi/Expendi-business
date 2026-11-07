import { describe, expect, it } from "vitest";

import {
  approxKesTotal,
  formatKes,
  formatKesCents,
  formatUsdc,
  sumUnits,
  totalsByCurrency,
  usdcToKesCents,
} from "./money";

describe("formatKesCents", () => {
  it("formats cents with grouped shillings", () => {
    // #when
    const formatted = formatKesCents("16012345");

    // #then
    expect(formatted).toBe("160,123.45");
  });

  it("keeps every digit of an amount past a float's precision", () => {
    // #when
    const formatted = formatKesCents("9007199254740993");

    // #then
    expect(formatted).toBe("90,071,992,547,409.93");
  });

  it("pads amounts under a shilling", () => {
    // #when
    const formatted = formatKesCents("5");

    // #then
    expect(formatted).toBe("0.05");
  });
});

describe("formatUsdc", () => {
  it("shows every non-zero decimal of base units, so nothing is rounded up", () => {
    // #when
    const formatted = [formatUsdc("1234500000"), formatUsdc("11660001")];

    // #then
    expect(formatted).toEqual(["1,234.50", "11.660001"]);
  });
});

describe("sumUnits", () => {
  it("adds integer amounts without floats", () => {
    // #when
    const total = sumUnits(["9007199254740993", "1", "150050"]);

    // #then
    expect(total).toBe("9007199254891044");
  });

  it("is zero for nothing", () => {
    // #then
    expect(sumUnits([])).toBe("0");
  });
});

describe("formatKes", () => {
  it("drops the decimals of whole shillings and keeps them otherwise", () => {
    // #when
    const formatted = [
      formatKes("4850000"),
      formatKes("699950"),
      formatKes("5"),
    ];

    // #then
    expect(formatted).toEqual(["48,500", "6,999.50", "0.05"]);
  });
});

describe("usdcToKesCents", () => {
  it("converts at the rate and rounds down to the cent", () => {
    // #when
    const converted = [
      usdcToKesCents("45000000", "128.68"),
      usdcToKesCents("1", "129"),
    ];

    // #then
    expect(converted).toEqual(["579060", "0"]);
  });

  it("refuses a rate that isn't a plain decimal", () => {
    // #then
    expect(usdcToKesCents("45000000", "1e3")).toBeNull();
  });
});

describe("totalsByCurrency", () => {
  it("adds each currency apart and skips amounts still to enter", () => {
    // #when
    const totals = totalsByCurrency([
      { currency: "kes", amount: "1250050" },
      { currency: "usd", amount: "45000000" },
      { currency: "kes", amount: null },
      { currency: "kes", amount: "100" },
    ]);

    // #then
    expect(totals).toEqual({ kes: "1250150", usd: "45000000" });
  });
});

describe("approxKesTotal", () => {
  it("is exact when there is no USD, even without a rate", () => {
    // #when
    const total = approxKesTotal({ kes: "1250050", usd: "0", rate: null });

    // #then
    expect(total).toEqual({ kesCents: "1250050", approximate: false });
  });

  it("converts USD at today's rate into one approximate KES figure", () => {
    // #when
    const total = approxKesTotal({
      kes: "1250050",
      usd: "45000000",
      rate: "129",
    });

    // #then
    expect(total).toEqual({ kesCents: "1830550", approximate: true });
  });

  it("has no figure for USD without a usable rate", () => {
    // #then
    expect({
      none: approxKesTotal({ kes: "100", usd: "45000000", rate: null }),
      bad: approxKesTotal({ kes: "100", usd: "45000000", rate: "n/a" }),
    }).toEqual({ none: null, bad: null });
  });
});
