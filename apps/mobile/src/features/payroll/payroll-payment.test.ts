import { describe, expect, it } from "vitest";

import type { PayrollPersonPreview } from "@expendi-business/shared";

import { parseMarginPct, personRows, progressInWords } from "./payroll-payment";

const person = (
  overrides: Partial<PayrollPersonPreview> = {},
): PayrollPersonPreview => ({
  billId: "00000000-0000-4000-8000-000000000001",
  payeeName: "Amina Wanjiru",
  paidTo: { method: "mpesa_phone", label: "M-Pesa ending 5678" },
  amountKes: "6000000",
  receivesKes: "6000000",
  orders: 1,
  payoutIds: ["00000000-0000-4000-8000-000000000002"],
  rate: "128.68",
  usdc: "466273000",
  feeAllowanceUsdc: "2581365",
  maxDebitUsdc: "468854365",
  ...overrides,
});

describe("personRows", () => {
  it("shows what they receive, where, and the most it costs", () => {
    // #then
    expect(personRows(person())).toEqual([
      { label: "They receive", value: "KES 60,000.00" },
      { label: "Paid to", value: "M-Pesa ending 5678" },
      { label: "Total, at most", value: "468.854365 USDC" },
    ]);
  });

  it("says a salary above one cash-out's limit is sent in parts", () => {
    // #when
    const rows = personRows(
      person({ amountKes: "50000050", receivesKes: "50000100", orders: 2 }),
    );

    // #then
    expect(rows.map((row) => row.label)).toEqual([
      "They receive",
      "Pay",
      "Paid to",
      "Sent as",
      "Total, at most",
    ]);
    expect(rows[3]?.value).toContain("2 payments");
  });
});

describe("progressInWords", () => {
  it.each([
    ["draft", { paid: 0, paying: 0, failed: 0 }, null],
    ["paying", { paid: 1, paying: 2, failed: 0 }, "1 paid · 2 being paid"],
    ["partly_failed", { paid: 2, paying: 0, failed: 1 }, "2 paid · 1 failed"],
    ["paid", { paid: 3, paying: 0, failed: 0 }, "3 paid"],
  ] as const)("a %s run reads %j", (status, progress, expected) => {
    // #then
    expect(progressInWords({ status, progress })).toBe(expected);
  });
});

describe("parseMarginPct", () => {
  it.each([
    ["25", 25],
    [" 30% ", 30],
    ["0", 0],
    ["100", 100],
    ["101", null],
    ["12.5", null],
    ["", null],
  ])("reads %j as %j", (typed, expected) => {
    // #then
    expect(parseMarginPct(typed)).toBe(expected);
  });
});
