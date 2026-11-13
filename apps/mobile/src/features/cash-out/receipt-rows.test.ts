import { describe, expect, it } from "vitest";

import type { CashOutReceipt } from "@expendi-business/shared";

import { cashOutReceiptCopy, cashOutReceiptRows } from "./receipt-rows";

const mpesa = (code: string): CashOutReceipt => ({ kind: "mpesa", code });
const bank = (code: string): CashOutReceipt => ({ kind: "bank", code });

describe("cashOutReceiptRows", () => {
  it("shows one M-Pesa receipt", () => {
    // #when
    const rows = cashOutReceiptRows([mpesa("UKDCW299LW")]);

    // #then
    expect(rows).toEqual([{ label: "M-Pesa receipt", value: "UKDCW299LW" }]);
  });

  it("calls a bank transfer's code a bank reference", () => {
    // #when
    const rows = cashOutReceiptRows([bank("FT26317XK9")]);

    // #then
    expect(rows).toEqual([{ label: "Bank reference", value: "FT26317XK9" }]);
  });

  it("puts a split payment's codes on one row, in the order they were paid", () => {
    // #when
    const rows = cashOutReceiptRows([
      mpesa("UKDCW299LW"),
      mpesa("UKDCW301MX"),
      mpesa("UKDCW305PQ"),
    ]);

    // #then
    expect(rows).toEqual([
      {
        label: "M-Pesa receipts",
        value: "UKDCW299LW, UKDCW301MX, UKDCW305PQ",
      },
    ]);
  });

  it("gives each kind its own row", () => {
    // #when
    const rows = cashOutReceiptRows([
      bank("FT1"),
      mpesa("UKDCW299LW"),
      bank("FT2"),
    ]);

    // #then
    expect(rows).toEqual([
      { label: "Bank references", value: "FT1, FT2" },
      { label: "M-Pesa receipt", value: "UKDCW299LW" },
    ]);
  });

  it("has no row before a cash-out is paid", () => {
    // #when
    const rows = cashOutReceiptRows([]);

    // #then
    expect(rows).toEqual([]);
  });
});

describe("cashOutReceiptCopy", () => {
  it.each([
    [[mpesa("A1")], "Copy M-Pesa receipt", "A1"],
    [[mpesa("A1"), mpesa("A2")], "Copy M-Pesa receipts", "A1, A2"],
    [[bank("B1")], "Copy bank reference", "B1"],
    [[bank("B1"), bank("B2")], "Copy bank references", "B1, B2"],
    [[mpesa("A1"), bank("B1")], "Copy the codes", "A1, B1"],
  ])("copies %j with the label %s", (receipts, label, value) => {
    // #when
    const copy = cashOutReceiptCopy(receipts);

    // #then
    expect(copy).toEqual({ label, value });
  });

  it("has nothing to copy before a cash-out is paid", () => {
    // #when
    const copy = cashOutReceiptCopy([]);

    // #then
    expect(copy).toBeNull();
  });
});
