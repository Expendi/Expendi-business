import { describe, expect, it } from "vitest";

import { formatBillAmount, kesCentsAtRate } from "./bill-amount";

describe("kesCentsAtRate", () => {
  it("values USDC in KES cents at Paycrest's rate, rounding down like the API", () => {
    // #then
    expect([
      kesCentsAtRate("45000000", "128.68"),
      kesCentsAtRate("1", "128.68"),
      kesCentsAtRate("1000000", "129.123456"),
    ]).toEqual(["579060", "0", "12912"]);
  });

  it("gives no value for a rate it can't read", () => {
    // #then
    expect([kesCentsAtRate("1000000", "1e3"), kesCentsAtRate("1", "")]).toEqual(
      [null, null],
    );
  });
});

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
