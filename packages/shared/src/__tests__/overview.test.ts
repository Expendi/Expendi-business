import { describe, expect, it } from "vitest";

import { cashFootnote } from "../overview.js";

describe("cashFootnote", () => {
  it("says what isn't counted without naming a cash-out provider", () => {
    // #when
    const footnote = cashFootnote({
      today: "2026-11-02",
      through: "2026-12-02",
      totalKes: "1286800",
      unknownAmounts: 0,
      obligations: [],
      balanceUsdc: "100000000",
      reservedUsdc: "0",
      balanceKes: "1286800",
      availableKes: "1286800",
      rate: "128.68",
      status: "covered",
      shortKes: "0",
      outsideKes: "0",
    });

    // #then
    expect(footnote).toBe(
      "KES 12,868.00 to pay through Expendi by 2026-12-02, overdue included. Cash-out fees and bills paid outside Expendi aren't counted.",
    );
  });
});
