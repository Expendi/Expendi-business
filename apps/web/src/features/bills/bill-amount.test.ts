import { describe, expect, it } from "vitest";

import { formatBillAmount } from "./bill-amount";

describe("formatBillAmount", () => {
  it("shows a bill in its own currency, and nothing while a variable bill has no amount", () => {
    // #then
    expect([
      formatBillAmount({
        currency: "kes",
        amountKes: "1250050",
        amountUsdc: null,
      }),
      formatBillAmount({
        currency: "usd",
        amountKes: null,
        amountUsdc: "45500000",
      }),
      formatBillAmount({ currency: "kes", amountKes: null, amountUsdc: null }),
    ]).toEqual(["KES 12,500.50", "USD 45.50", null]);
  });
});
