import { describe, expect, it } from "vitest";

import type { PayoutRecipient } from "../../services/paycrest/recipient.js";
import type { PretiumRecipient } from "../../services/pretium/pretium-client.js";
import { InvalidRecipient } from "../../services/paycrest/recipient.js";
import {
  NotAPretiumCashOut,
  toPretiumRecipient,
} from "../../services/pretium/recipient.js";

const BANK: PayoutRecipient = {
  method: "bank",
  bankCode: "EQBLKENA",
  accountNumber: "0123456789",
  accountName: "Jane Wanjiku",
};

describe("toPretiumRecipient", () => {
  it.each<[string, PayoutRecipient, PretiumRecipient]>([
    [
      "an M-Pesa number",
      {
        method: "mpesa_phone",
        phone: "+254712345678",
        accountName: "Jane Wanjiku",
      },
      {
        type: "MOBILE",
        shortcode: "254712345678",
        mobileNetwork: "Safaricom",
      },
    ],
    [
      "a Till",
      { method: "mpesa_till", tillNumber: "123456", accountName: "Duka" },
      { type: "BUY_GOODS", shortcode: "123456" },
    ],
    [
      "a Paybill",
      {
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: " ACC-12 ",
        accountName: "KPLC",
      },
      { type: "PAYBILL", shortcode: "888880", accountNumber: "ACC-12" },
    ],
  ])("maps %s", (_name, recipient, expected) => {
    expect(toPretiumRecipient(recipient)).toEqual(expected);
  });

  it("maps a bank account to Pretium's code for the bank", () => {
    // #given
    const asked: string[] = [];

    // #when
    const mapped = toPretiumRecipient(BANK, (code) => {
      asked.push(code);
      return "247247";
    });

    // #then
    expect({ mapped, asked }).toEqual({
      mapped: {
        type: "BANK_TRANSFER",
        accountNumber: "0123456789",
        bankCode: "247247",
      },
      asked: ["EQBLKENA"],
    });
  });

  it("refuses a bank Pretium has no code for", () => {
    expect(() => toPretiumRecipient(BANK, () => null)).toThrow(
      NotAPretiumCashOut,
    );
  });

  it("looks the bank up in the catalogue by default", () => {
    expect(toPretiumRecipient(BANK)).toEqual({
      type: "BANK_TRANSFER",
      accountNumber: "0123456789",
      bankCode: "247247",
    });
  });

  it("refuses a catalogue bank Pretium doesn't list", () => {
    expect(() => toPretiumRecipient({ ...BANK, bankCode: "PRIEKENX" })).toThrow(
      NotAPretiumCashOut,
    );
  });

  it("refuses a USDC payee: that isn't a cash-out", () => {
    expect(() =>
      toPretiumRecipient({
        method: "usdc",
        chain: "base",
        address: "0x1111111111111111111111111111111111111111",
        accountName: "Vendor",
      }),
    ).toThrow(NotAPretiumCashOut);
  });

  it.each<[string, PayoutRecipient]>([
    [
      "a number that isn't Kenyan",
      { method: "mpesa_phone", phone: "+255712345678", accountName: "Jane" },
    ],
    [
      "a Till that is too short",
      { method: "mpesa_till", tillNumber: "12", accountName: "Duka" },
    ],
    [
      "a Paybill account reference with odd characters",
      {
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: "ACC;DROP",
        accountName: "KPLC",
      },
    ],
    [
      "a bank account number with spaces",
      { ...BANK, accountNumber: "0123 4567" },
    ],
  ])("refuses %s, as Paycrest would", (_name, recipient) => {
    expect(() => toPretiumRecipient(recipient, () => "247247")).toThrow(
      InvalidRecipient,
    );
  });
});
