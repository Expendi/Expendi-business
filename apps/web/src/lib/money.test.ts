import { describe, expect, it } from "vitest";

import { formatKesCents, formatUsdc, sumUnits } from "./money";

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
