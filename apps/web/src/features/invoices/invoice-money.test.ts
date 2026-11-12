import { describe, expect, it } from "vitest";

import {
  bpsToPercent,
  centsToDollars,
  computeTotals,
  dollarsToCents,
  formatCents,
  percentToBps,
} from "./invoice-money";

describe("dollars and cents", () => {
  it("converts typed dollars to exact cents, or refuses", () => {
    // #when
    const converted = ["120", "49.99", "1,200.5", "0.05", " 7 ", "0"].map(
      dollarsToCents,
    );
    const refused = ["", "1.234", "-5", "abc", "1e3", "$5"].map(dollarsToCents);

    // #then
    expect({ converted, refused }).toEqual({
      converted: ["12000", "4999", "120050", "5", "700", "0"],
      refused: [null, null, null, null, null, null],
    });
  });

  it("shows cents back as dollars, to edit and to read", () => {
    // #when
    const edit = ["5", "4999", "120050"].map(centsToDollars);
    const read = ["0", "5", "120050", "123456789"].map(formatCents);

    // #then
    expect({ edit, read }).toEqual({
      edit: ["0.05", "49.99", "1200.50"],
      read: ["0.00", "0.05", "1,200.50", "1,234,567.89"],
    });
  });
});

describe("tax rates", () => {
  it("turns percent into basis points and back", () => {
    // #then
    expect({
      bps: ["16", "7.5", "0.25", "100", "100.01", "abc", ""].map(percentToBps),
      back: [1600, 750, 25, 10000].map(bpsToPercent),
    }).toEqual({
      bps: [1600, 750, 25, 10000, null, null, null],
      back: ["16", "7.5", "0.25", "100"],
    });
  });
});

describe("invoice totals", () => {
  it("rounds each line half up, then the tax half up on the subtotal", () => {
    // #when
    const totals = computeTotals(
      [
        { quantity: "2.5", unitPriceCents: "333" },
        { quantity: "1", unitPriceCents: "1000" },
        { quantity: "oops", unitPriceCents: "100" },
        { quantity: "1", unitPriceCents: null },
      ],
      1600,
    );

    // #then
    expect(totals).toEqual({
      lineCents: ["833", "1000", null, null],
      subtotalCents: "1833",
      taxCents: "293",
      totalCents: "2126",
    });
  });

  it("adds no tax without a rate", () => {
    // #then
    expect(
      computeTotals([{ quantity: "3", unitPriceCents: "1999" }], null),
    ).toMatchObject({
      subtotalCents: "5997",
      taxCents: "0",
      totalCents: "5997",
    });
  });
});
