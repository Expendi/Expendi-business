import { describe, expect, it } from "vitest";

import {
  centsToUsdc,
  invoiceTotals,
  lineAmountCents,
} from "../../services/invoices/money.js";

describe("lineAmountCents", () => {
  it.each([
    ["1", 10_000n, 10_000n],
    ["2.5", 333n, 833n],
    ["0.5", 1n, 1n],
    ["0.499", 1n, 0n],
    ["0.001", 499n, 0n],
    ["0.001", 500n, 1n],
    ["1.005", 100n, 101n],
    ["3", 0n, 0n],
  ])("%s × %s cents is %s cents", (quantity, unitPrice, expected) => {
    expect(lineAmountCents(quantity, unitPrice)).toBe(expected);
  });

  it("stays exact where floats would not", () => {
    // 1.1 × 3 in floats is 3.3000000000000003.
    expect(lineAmountCents("1.1", 3n)).toBe(3n);
    expect(lineAmountCents("999999999999.999", 999_999_999_999_999n)).toBe(
      999_999_999_999_998_000_000_000_000n,
    );
  });

  it("refuses a quantity that isn't a decimal with up to three places", () => {
    expect(() => lineAmountCents("1.2345", 1n)).toThrow(RangeError);
    expect(() => lineAmountCents("-1", 1n)).toThrow(RangeError);
  });
});

describe("invoiceTotals", () => {
  const lines = [
    { quantity: "2", unitPriceCents: 12_345n },
    { quantity: "1.5", unitPriceCents: 3_333n },
  ];

  it("sums the lines and adds no tax without a rate", () => {
    expect(invoiceTotals(lines, null)).toEqual({
      lineAmounts: [24_690n, 5_000n],
      subtotalCents: 29_690n,
      taxCents: 0n,
      totalCents: 29_690n,
    });
  });

  it("taxes the subtotal, rounded half up to the cent", () => {
    // 16% of 29_690 is 4_750.4
    expect(invoiceTotals(lines, 1600)).toMatchObject({
      taxCents: 4_750n,
      totalCents: 34_440n,
    });
    // 0.5% of 100 is exactly half a cent: rounds up.
    expect(
      invoiceTotals([{ quantity: "1", unitPriceCents: 100n }], 50).taxCents,
    ).toBe(1n);
    expect(
      invoiceTotals([{ quantity: "1", unitPriceCents: 99n }], 50).taxCents,
    ).toBe(0n);
  });

  it("rounds the tax once, on the subtotal, not per line", () => {
    const small = [
      { quantity: "1", unitPriceCents: 3n },
      { quantity: "1", unitPriceCents: 3n },
    ];
    // 6 × 8.33% = 0.4998 → 0; per line it would be 0.2499 → 0 each.
    expect(invoiceTotals(small, 833).taxCents).toBe(0n);
    // 6 × 10% = 0.6 → 1; per line it would be 0.3 → 0 each.
    expect(invoiceTotals(small, 1000).taxCents).toBe(1n);
  });

  it("totals nothing for no lines", () => {
    expect(invoiceTotals([], 1600).totalCents).toBe(0n);
  });
});

describe("centsToUsdc", () => {
  it("is 10_000 base units per cent", () => {
    expect(centsToUsdc(100n)).toBe(1_000_000n);
    expect(centsToUsdc(0n)).toBe(0n);
    expect(centsToUsdc(1n)).toBe(10_000n);
  });
});
