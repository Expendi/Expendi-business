import { describe, expect, it } from "vitest";

import { billSchema } from "../bills.js";
import {
  cashOutReceiptLabel,
  cashOutReceiptSchema,
  paymentReceiptsSchema,
} from "../cash-out-receipt.js";

describe("cashOutReceiptSchema", () => {
  it.each([
    ["an M-Pesa receipt", { kind: "mpesa", code: "UKDCW299LW" }],
    ["a bank reference", { kind: "bank", code: "FT26317XK9QZ" }],
  ])("accepts %s", (_name, receipt) => {
    expect(cashOutReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it.each([
    ["an empty code", { kind: "mpesa", code: "" }],
    ["a USDC payout's hash", { kind: "usdc", code: "0xabc" }],
    ["no code", { kind: "bank" }],
  ])("refuses %s", (_name, receipt) => {
    expect(cashOutReceiptSchema.safeParse(receipt).success).toBe(false);
  });
});

describe("paymentReceiptsSchema", () => {
  it("reads a response from an API built before receipts as none", () => {
    // #given
    const fromOlderApi = undefined;

    // #when
    const receipts = paymentReceiptsSchema.parse(fromOlderApi);

    // #then
    expect(receipts).toEqual([]);
  });

  it("gives each response its own empty list", () => {
    // #given
    const first = paymentReceiptsSchema.parse(undefined);

    // #when
    first.push({ kind: "mpesa", code: "UKDCW299LW" });

    // #then
    expect(paymentReceiptsSchema.parse(undefined)).toEqual([]);
  });

  it("keeps the receipts in the order sent", () => {
    // #given
    const sent = [
      { kind: "mpesa", code: "UKD1" },
      { kind: "mpesa", code: "UKD2" },
    ];

    // #when
    const receipts = paymentReceiptsSchema.parse(sent);

    // #then
    expect(receipts.map((receipt) => receipt.code)).toEqual(["UKD1", "UKD2"]);
  });
});

describe("a bill from an API built before receipts", () => {
  it("parses, with no receipts", () => {
    // #given
    const bill = {
      id: "0b6f7d2e-6f0e-4c39-9d63-0f8e6b9b2a11",
      status: "paid",
      payee: {
        id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        name: "Kenya Power",
        kind: "supplier",
        method: "mpesa_till",
        archived: false,
      },
      overviewHeading: "transactions",
      category: { id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a", name: "Power" },
      variable: false,
      currency: "kes",
      amountKes: "250000",
      amountUsdc: null,
      reference: null,
      notes: null,
      dueOn: "2026-11-01",
      recurringItemId: null,
      payrollRunId: null,
      adjustmentReason: null,
      paidOn: "2026-11-01",
      paidAt: "2026-11-01T09:00:00.000Z",
      markedPaidBy: null,
      paidOutsideNote: null,
      cancelledReason: null,
      cancelledAt: null,
      cancelledBy: null,
      payoutId: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b",
      fileCount: 0,
      createdAt: "2026-10-30T09:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
    };

    // #when
    const parsed = billSchema.parse(bill);

    // #then
    expect(parsed.paymentReceipts).toEqual([]);
  });
});

describe("cashOutReceiptLabel", () => {
  it.each([
    ["mpesa", 1, "M-Pesa receipt"],
    ["mpesa", 2, "M-Pesa receipts"],
    ["bank", 1, "Bank reference"],
    ["bank", 3, "Bank references"],
  ] as const)("calls %s × %i %s", (kind, count, label) => {
    expect(cashOutReceiptLabel(kind, count)).toBe(label);
  });

  it("names one receipt when no count is given", () => {
    expect(cashOutReceiptLabel("mpesa")).toBe("M-Pesa receipt");
  });
});
