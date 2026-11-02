import { describe, expect, it } from "vitest";

import type { ParsedEtimsQr } from "../etims-qr.js";
import { ETIMS_QR_MAX_BYTES, parseEtimsQr } from "../etims-qr.js";

/*
 * Payloads follow the layouts KRA's receipt pages use (see etims-qr.ts);
 * the PINs, signatures and invoice numbers are invented. Real scanned QR
 * codes join these once pilot receipts are collected.
 */

interface Fixture {
  name: string;
  payload: string;
  expected: ParsedEtimsQr;
}

const ETIMS = (data: string) =>
  `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=${data}`;

const RECOGNISED: Fixture[] = [
  {
    name: "an eTIMS receipt from a head-office till",
    payload: ETIMS("P051234567X00ABCDEF0123456789"),
    expected: {
      format: "etims",
      invoiceNumber: null,
      supplierPin: "P051234567X",
      branchId: "00",
      receiptSignature: "ABCDEF0123456789",
    },
  },
  {
    name: "an eTIMS sandbox receipt from branch 02",
    payload:
      "https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P000000001G02FGUWWXNHSOSKVDCI",
    expected: {
      format: "etims",
      invoiceNumber: null,
      supplierPin: "P000000001G",
      branchId: "02",
      receiptSignature: "FGUWWXNHSOSKVDCI",
    },
  },
  {
    name: "an eTIMS link with a lowercase key and data, over http, with trailing space",
    payload: `  http://ETIMS.KRA.GO.KE/common/link/etims/receipt/indexEtimsReceiptData?data=a123456789z01qwertyuiop123456\n`,
    expected: {
      format: "etims",
      invoiceNumber: null,
      supplierPin: "A123456789Z",
      branchId: "01",
      receiptSignature: "QWERTYUIOP123456",
    },
  },
  {
    name: "an eTIMS link carrying only the PIN",
    payload: ETIMS("P051234567X"),
    expected: {
      format: "etims",
      invoiceNumber: null,
      supplierPin: "P051234567X",
      branchId: null,
      receiptSignature: null,
    },
  },
  {
    name: "a TIMS (ETR) receipt",
    payload:
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0110600190000154458",
    expected: {
      format: "tims",
      invoiceNumber: "0110600190000154458",
      supplierPin: null,
      branchId: null,
      receiptSignature: null,
    },
  },
  {
    name: "a TIMS receipt with the invoice number padded with spaces",
    payload:
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0090541490000469265%20%20%20%20",
    expected: {
      format: "tims",
      invoiceNumber: "0090541490000469265",
      supplierPin: null,
      branchId: null,
      receiptSignature: null,
    },
  },
  {
    name: "a TIMS link that also names the trader's PIN",
    payload:
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=KRACU0100000001%2F123&traderPin=p051234567x",
    expected: {
      format: "tims",
      invoiceNumber: "KRACU0100000001/123",
      supplierPin: "P051234567X",
      branchId: null,
      receiptSignature: null,
    },
  },
  {
    name: "a bare eTIMS CU invoice number",
    payload: "kracu0100000001/123",
    expected: {
      format: "invoice_number",
      invoiceNumber: "KRACU0100000001/123",
      supplierPin: null,
      branchId: null,
      receiptSignature: null,
    },
  },
  {
    name: "a bare 19-digit TIMS invoice number",
    payload: "0110600190000154458",
    expected: {
      format: "invoice_number",
      invoiceNumber: "0110600190000154458",
      supplierPin: null,
      branchId: null,
      receiptSignature: null,
    },
  },
];

describe("parseEtimsQr", () => {
  it.each(RECOGNISED)("reads $name", ({ payload, expected }) => {
    // #when
    const result = parseEtimsQr(payload);

    // #then
    expect(result).toEqual({ ok: true, qr: expected });
  });

  it.each([
    [
      "a vendor's own receipt link",
      "https://etims.ke/r/clno9s9zb02fqs601u5i79a06/v5241554",
    ],
    [
      "a look-alike host",
      "https://etims.kra.go.ke.example.com/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00ABCDEF0123456789",
    ],
    [
      "a host that only ends in kra.go.ke",
      "https://notkra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00ABCDEF0123456789",
    ],
    [
      "an eTIMS link with a malformed PIN",
      ETIMS("X051234567X00ABCDEF0123456789"),
    ],
    ["an eTIMS link without data", ETIMS("")],
    [
      "an invoice link outside KRA",
      "https://shop.example.com/invoiceChk.htm?invoiceNo=0110600190000154458",
    ],
    [
      "a KRA page without an invoice number",
      "https://itax.kra.go.ke/KRA-Portal/",
    ],
    ["a payment QR", "upi://pay?pa=shop@bank&am=100"],
    ["random text", "Thank you for shopping with us"],
    ["a short number", "12345"],
  ])("doesn't recognise %s", (_name, payload) => {
    // #when
    const result = parseEtimsQr(payload);

    // #then
    expect(result).toEqual({ ok: false, reason: "unrecognised" });
  });

  it("says an empty scan is empty", () => {
    // #when
    const result = parseEtimsQr("   ");

    // #then
    expect(result).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a payload over 2 KB, counting UTF-8 bytes", () => {
    // #given
    const atLimit = "a".repeat(ETIMS_QR_MAX_BYTES);
    const overLimit = `${"a".repeat(ETIMS_QR_MAX_BYTES - 1)}é`;

    // #when
    const results = [parseEtimsQr(atLimit), parseEtimsQr(overLimit)];

    // #then
    expect(results).toEqual([
      { ok: false, reason: "unrecognised" },
      { ok: false, reason: "too_long" },
    ]);
  });

  it("keeps a malformed escape instead of throwing", () => {
    // #when
    const result = parseEtimsQr(
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?invoiceNo=0110600190000154458&note=%E0%A4%A",
    );

    // #then
    expect(result).toMatchObject({
      ok: true,
      qr: { invoiceNumber: "0110600190000154458" },
    });
  });

  it("never throws on random input", () => {
    // #given
    const alphabet = "https://kra.go.ke/?&=%#@:/ABCdef0123456789 \né​";
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };

    // #when
    const parse = () => {
      for (let run = 0; run < 2_000; run += 1) {
        const length = Math.floor(random() * 120);
        let payload = "";
        for (let index = 0; index < length; index += 1) {
          payload += alphabet[Math.floor(random() * alphabet.length)];
        }
        parseEtimsQr(payload);
      }
    };

    // #then
    expect(parse).not.toThrow();
  });
});
