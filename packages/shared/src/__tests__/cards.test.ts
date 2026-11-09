import { describe, expect, it } from "vitest";

import { formatUsdCents } from "../cards.js";

describe("formatUsdCents", () => {
  it("formats whole dollars and cents", () => {
    expect(formatUsdCents(150050n)).toBe("USD 1,500.50");
    expect(formatUsdCents(0n)).toBe("USD 0.00");
  });

  it("keeps the sign on a Card balance a late clearing took below zero", () => {
    expect(formatUsdCents(-50n)).toBe("-USD 0.50");
  });
});
