import { describe, expect, it } from "vitest";

import type { ReceiptExtractionResponse } from "@expendi-business/shared";

import type { ClaimDraft } from "./draft";
import {
  applyChosenPrefill,
  applyReceiptPrefill,
  initialDraftState,
  readPastedSms,
  readScannedQr,
  receiptPrefill,
  typeField,
  UNREADABLE_SMS,
} from "./draft";

const EMPTY: ClaimDraft = {
  merchant: "",
  amount: "",
  spentOn: "2026-11-02",
  categoryId: null,
  description: "",
  mpesaCode: "",
  etimsInvoiceNumber: "",
  etimsSupplierPin: "",
  etimsQrPayload: null,
};

const PAYBILL =
  "SLK4H7Q2XY Confirmed. Ksh2,345.50 sent to KPLC PREPAID for account 12345678 on 1/1/26 at 12:05 AM New M-PESA balance is Ksh1,000.00. Transaction cost, Ksh23.00.";

describe("readPastedSms", () => {
  it("fills the merchant, amount, Nairobi date and M-Pesa code from a payment SMS", () => {
    // #when
    const reading = readPastedSms(PAYBILL);

    // #then
    expect(reading).toEqual({
      ok: true,
      text: PAYBILL,
      prefill: {
        merchant: "KPLC PREPAID",
        amount: "2,345.50",
        spentOn: "2026-01-01",
        mpesaCode: "SLK4H7Q2XY",
      },
    });
  });

  it.each([
    "",
    "Lunch was 1500 at Java",
    "Confirmed. You have received Ksh500",
  ])("falls back to manual entry for %j", (text) => {
    // #when
    const reading = readPastedSms(text);

    // #then
    expect(reading).toEqual({ ok: false, message: UNREADABLE_SMS });
  });
});

describe("applyChosenPrefill", () => {
  it("replaces what the person typed and marks the fields as from the SMS", () => {
    // #given
    const typed = typeField(initialDraftState(EMPTY), "amount", "1,000");
    const reading = readPastedSms(PAYBILL);
    if (!reading.ok) throw new Error("fixture didn't parse");

    // #when
    const state = applyChosenPrefill(typed, reading.prefill);

    // #then
    expect(state).toEqual({
      draft: {
        ...EMPTY,
        merchant: "KPLC PREPAID",
        amount: "2,345.50",
        spentOn: "2026-01-01",
        mpesaCode: "SLK4H7Q2XY",
      },
      sources: {
        merchant: "sms",
        amount: "sms",
        spentOn: "sms",
        mpesaCode: "sms",
      },
      typed: [],
    });
  });
});

describe("typeField", () => {
  it("drops the field's source once the person edits it", () => {
    // #given
    const reading = readPastedSms(PAYBILL);
    if (!reading.ok) throw new Error("fixture didn't parse");
    const prefilled = applyChosenPrefill(
      initialDraftState(EMPTY),
      reading.prefill,
    );

    // #when
    const state = typeField(prefilled, "merchant", "Kenya Power");

    // #then
    expect(state.sources.merchant).toBeUndefined();
  });
});

const READ: Extract<ReceiptExtractionResponse, { status: "read" }> = {
  status: "read",
  fields: {
    merchant: "Naivas Supermarket",
    amountKes: "123450",
    spentOn: "2026-10-30",
    mpesaCode: null,
    etimsInvoiceNumber: "KRACU0100000001/123",
    etimsSupplierPin: "P051234567X",
  },
  lowConfidence: ["amountKes", "mpesaCode"],
  amountNotInKes: false,
};

describe("receiptPrefill", () => {
  it("fills what was read and flags only filled fields that were hard to read", () => {
    // #when
    const reading = receiptPrefill(READ);

    // #then
    expect(reading).toEqual({
      prefill: {
        merchant: "Naivas Supermarket",
        amount: "1,234.50",
        spentOn: "2026-10-30",
        etimsInvoiceNumber: "KRACU0100000001/123",
        etimsSupplierPin: "P051234567X",
      },
      unsure: ["amount"],
    });
  });

  it("leaves the amount out when it isn't in KES", () => {
    // #when
    const reading = receiptPrefill({
      ...READ,
      fields: { ...READ.fields, amountKes: null },
      amountNotInKes: true,
    });

    // #then
    expect(reading.prefill.amount).toBeUndefined();
  });
});

describe("applyReceiptPrefill", () => {
  it("fills untouched fields, marking the unsure ones, and keeps typed and SMS values", () => {
    // #given
    const sms = readPastedSms(PAYBILL);
    if (!sms.ok) throw new Error("fixture didn't parse");
    const fromSms = applyChosenPrefill(initialDraftState(EMPTY), {
      mpesaCode: sms.prefill.mpesaCode,
    });
    const state = typeField(fromSms, "merchant", "Naivas Westlands");

    // #when
    const filled = applyReceiptPrefill(state, receiptPrefill(READ));

    // #then
    expect(filled.draft).toMatchObject({
      merchant: "Naivas Westlands",
      amount: "1,234.50",
      spentOn: "2026-10-30",
      mpesaCode: "SLK4H7Q2XY",
      etimsInvoiceNumber: "KRACU0100000001/123",
    });
    expect(filled.sources).toEqual({
      mpesaCode: "sms",
      amount: "receipt_unsure",
      spentOn: "receipt",
      etimsInvoiceNumber: "receipt",
      etimsSupplierPin: "receipt",
    });
  });

  it("leaves an edit's own values alone", () => {
    // #given
    const editing = initialDraftState(
      { ...EMPTY, merchant: "Java House", amount: "800.00" },
      ["merchant", "amount", "spentOn"],
    );

    // #when
    const filled = applyReceiptPrefill(editing, receiptPrefill(READ));

    // #then
    expect(filled.draft).toMatchObject({
      merchant: "Java House",
      amount: "800.00",
      spentOn: "2026-11-02",
    });
  });
});

describe("readScannedQr", () => {
  it("takes the supplier's PIN from an eTIMS QR and asks for the invoice number", () => {
    // #given
    const payload =
      "https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00ABCDEF0123456789";

    // #when
    const scanned = readScannedQr(payload);

    // #then
    expect(scanned).toEqual({
      payload,
      prefill: { etimsSupplierPin: "P051234567X" },
      note: "eTIMS QR scanned. Type the invoice number printed under the QR code.",
    });
  });

  it("takes the invoice number from a TIMS QR", () => {
    // #when
    const scanned = readScannedQr(
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0110600190000154458",
    );

    // #then
    expect(scanned.prefill).toEqual({
      etimsInvoiceNumber: "0110600190000154458",
    });
  });

  it("keeps an unknown code and lets the person type the number", () => {
    // #when
    const scanned = readScannedQr("Thank you for shopping");

    // #then
    expect(scanned).toMatchObject({
      payload: "Thank you for shopping",
      prefill: {},
    });
    expect(scanned.note).toContain("type the invoice number");
  });

  it("marks what the QR filled", () => {
    // #given
    const scanned = readScannedQr(
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?invoiceNo=0110600190000154458",
    );

    // #when
    const state = applyChosenPrefill(
      typeField(initialDraftState(EMPTY), "etimsQrPayload", scanned.payload),
      scanned.prefill,
      "qr",
    );

    // #then
    expect(state.sources).toEqual({ etimsInvoiceNumber: "qr" });
  });
});
