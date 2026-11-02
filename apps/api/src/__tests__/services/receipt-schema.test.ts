import { describe, expect, it } from "vitest";

import type { ReceiptReply } from "../../services/extraction/receipt-schema.js";
import {
  checkReceiptReply,
  decimalToCents,
  isPlausibleReceiptDate,
} from "../../services/extraction/receipt-schema.js";

const NOW = new Date("2026-11-02T09:00:00Z");

const REPLY: ReceiptReply = {
  readable: true,
  unreadableReason: null,
  kind: "paper_receipt",
  merchant: "Naivas Supermarket",
  amount: "1,234.50",
  currency: "KES",
  date: "2026-10-30",
  mpesaCode: "SLK4H7XY2Z",
  etimsInvoiceNumber: "0040799830000012345",
  supplierKraPin: "P051234567X",
  uncertainFields: [],
};

describe("decimalToCents", () => {
  it.each([
    ["1,234.50", "123450"],
    ["1234.5", "123450"],
    ["850", "85000"],
    ["0.29", "29"],
    ["1,234.57", "123457"],
    ["4,321.10", "432110"],
    ["99,999,999.99", "9999999999"],
    ["100,000,000", "10000000000"],
  ])("converts %s to %s cents with integer maths", (printed, cents) => {
    // #when
    const result = decimalToCents(printed);

    // #then
    expect(result).toBe(cents);
  });

  it.each([
    "12.345",
    "1,23",
    "12,34.00",
    "1.234,50",
    "-5",
    "0",
    "0.00",
    "1e3",
    "KSh 100",
    "",
    "100,000,000.01",
    "712,345,678",
  ])("rejects %j", (printed) => {
    // #when
    const result = decimalToCents(printed);

    // #then
    expect(result).toBeNull();
  });
});

describe("isPlausibleReceiptDate", () => {
  it.each([
    ["2026-11-03", true],
    ["2026-11-04", false],
    ["2000-01-01", true],
    ["1999-12-31", false],
  ])("on 2 November 2026, %s is plausible: %s", (date, plausible) => {
    // #when
    const result = isPlausibleReceiptDate(date, NOW);

    // #then
    expect(result).toBe(plausible);
  });
});

describe("checkReceiptReply", () => {
  it("turns a valid reply into claim fields with KES cents", () => {
    // #when
    const check = checkReceiptReply(
      { ...REPLY, uncertainFields: ["merchant"] },
      NOW,
    );

    // #then
    expect(check).toEqual({
      ok: true,
      flags: [],
      fields: {
        kind: "paper_receipt",
        merchant: "Naivas Supermarket",
        amountCents: "123450",
        currency: "KES",
        date: "2026-10-30",
        mpesaCode: "SLK4H7XY2Z",
        etimsInvoiceNumber: "0040799830000012345",
        supplierKraPin: "P051234567X",
        confidence: {
          merchant: "low",
          amount: "high",
          currency: "high",
          date: "high",
          mpesaCode: "high",
          etimsInvoiceNumber: "high",
          supplierKraPin: "high",
        },
      },
    });
  });

  it("tidies spacing and case without changing what was read", () => {
    // #when
    const check = checkReceiptReply(
      {
        ...REPLY,
        merchant: "  Java House  ",
        currency: " kes",
        mpesaCode: "slk4 h7xy2z",
        supplierKraPin: "p051234567x",
        etimsInvoiceNumber: "   ",
      },
      NOW,
    );

    // #then
    expect(check.ok && check.fields).toMatchObject({
      merchant: "Java House",
      currency: "KES",
      mpesaCode: "SLK4H7XY2Z",
      supplierKraPin: "P051234567X",
      etimsInvoiceNumber: null,
    });
  });

  it("leaves fields that weren't shown empty, with no confidence for them", () => {
    // #when
    const check = checkReceiptReply(
      {
        ...REPLY,
        kind: "mpesa_screenshot",
        etimsInvoiceNumber: null,
        supplierKraPin: null,
      },
      NOW,
    );

    // #then
    expect(check.ok && check.fields.etimsInvoiceNumber).toBeNull();
    expect(check.ok && check.fields.confidence).not.toHaveProperty(
      "supplierKraPin",
    );
  });

  it.each(["USD", null])(
    "flags an amount in currency %j, which can't pre-fill KES",
    (currency) => {
      // #when
      const check = checkReceiptReply({ ...REPLY, currency }, NOW);

      // #then
      expect(check.ok && check.flags).toEqual(["currency_not_kes"]);
    },
  );

  it.each([
    ["an impossible date", { date: "2024-02-30" }],
    ["a date in the future", { date: "2999-01-01" }],
    ["a misread year", { date: "1924-10-30" }],
    ["a date in another format", { date: "30/10/2026" }],
    ["an amount with three decimals", { amount: "12.345" }],
    ["a phone number read as the amount", { amount: "712,345,678" }],
    ["a zero amount", { amount: "0.00" }],
    ["a malformed M-Pesa code", { mpesaCode: "SLK4H7XY2" }],
    ["a malformed KRA PIN", { supplierKraPin: "X051234567X" }],
    ["a currency that isn't a code", { currency: "Shillings" }],
    ["an unknown kind", { kind: "receipt" }],
  ])("rejects a reply with %s", (_label, change) => {
    // #when
    const check = checkReceiptReply({ ...REPLY, ...change }, NOW);

    // #then
    expect(check).toEqual({ ok: false, reason: "invalid_reply" });
  });

  it.each([
    ["missing fields", { readable: true, merchant: "Naivas" }],
    ["not an object", "Naivas, KES 1,234.50"],
    ["a number as the amount", { ...REPLY, amount: 1234.5 }],
  ])("rejects a reply with %s", (_label, reply) => {
    // #when
    const check = checkReceiptReply(reply, NOW);

    // #then
    expect(check).toEqual({ ok: false, reason: "invalid_reply" });
  });

  it("passes on Claude's reason when it couldn't read the image", () => {
    // #when
    const check = checkReceiptReply(
      { ...REPLY, readable: false, unreadableReason: "not_a_receipt" },
      NOW,
    );

    // #then
    expect(check).toEqual({ ok: false, reason: "not_a_receipt" });
  });

  it("treats a reply with no merchant, amount or date as illegible", () => {
    // #when
    const check = checkReceiptReply(
      { ...REPLY, merchant: null, amount: "", date: null },
      NOW,
    );

    // #then
    expect(check).toEqual({ ok: false, reason: "illegible" });
  });
});
