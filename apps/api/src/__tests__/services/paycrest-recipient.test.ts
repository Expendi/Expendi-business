import { describe, expect, it } from "vitest";

import type { KesRecipient } from "../../services/paycrest/recipient.js";
import { buildOrderRequest } from "../../services/paycrest/order-request.js";
import {
  InvalidRecipient,
  toPaycrestRecipient,
} from "../../services/paycrest/recipient.js";

const MEMO = "Expendi Business payout";

describe("toPaycrestRecipient", () => {
  it.each<[string, KesRecipient, ReturnType<typeof toPaycrestRecipient>]>([
    [
      "an M-Pesa number",
      {
        method: "mpesa_phone",
        phone: "+254712345678",
        accountName: "Jane Wanjiku",
      },
      {
        institution: "SAFAKEPC",
        accountIdentifier: "254712345678",
        accountName: "Jane Wanjiku",
        memo: MEMO,
        metadata: { channel: "Mobile" },
      },
    ],
    [
      "a Till",
      { method: "mpesa_till", tillNumber: "123456", accountName: "Java House" },
      {
        institution: "SAFAKEPC",
        accountIdentifier: "123456",
        accountName: "Java House",
        memo: MEMO,
        metadata: { channel: "Till" },
      },
    ],
    [
      "a Paybill with its account number",
      {
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: "ACC-1029",
        accountName: "Kenya Power",
      },
      {
        institution: "SAFAKEPC",
        accountIdentifier: "ACC-1029",
        accountName: "Kenya Power",
        memo: MEMO,
        metadata: { channel: "Paybill", businessNumber: "888880" },
      },
    ],
    [
      "a Kenyan bank account",
      {
        method: "bank",
        bankCode: "EQBLKENA",
        accountNumber: "0123456789012",
        accountName: "Acme Supplies Ltd",
      },
      {
        institution: "EQBLKENA",
        accountIdentifier: "0123456789012",
        accountName: "Acme Supplies Ltd",
        memo: MEMO,
      },
    ],
  ])("maps %s", (_label, recipient, expected) => {
    expect(toPaycrestRecipient(recipient, MEMO)).toEqual(expected);
  });

  it("collapses whitespace in the account name", () => {
    expect(
      toPaycrestRecipient(
        {
          method: "mpesa_till",
          tillNumber: "123456",
          accountName: "  Java   House ",
        },
        MEMO,
      ).accountName,
    ).toBe("Java House");
  });

  it.each<[string, KesRecipient]>([
    [
      "a non-Kenyan number",
      { method: "mpesa_phone", phone: "+255712345678", accountName: "A" },
    ],
    [
      "a local-format number",
      { method: "mpesa_phone", phone: "0712345678", accountName: "A" },
    ],
    [
      "a landline",
      { method: "mpesa_phone", phone: "+254201234567", accountName: "A" },
    ],
    [
      "a Till with letters",
      { method: "mpesa_till", tillNumber: "12A456", accountName: "A" },
    ],
    [
      "a 4-digit Paybill",
      {
        method: "mpesa_paybill",
        paybillNumber: "1234",
        accountReference: "X",
        accountName: "A",
      },
    ],
    [
      "a Paybill with no account number",
      {
        method: "mpesa_paybill",
        paybillNumber: "888880",
        accountReference: " ",
        accountName: "A",
      },
    ],
    [
      "a bank account with symbols",
      {
        method: "bank",
        bankCode: "EQBLKENA",
        accountNumber: "0123-456",
        accountName: "A",
      },
    ],
    [
      "a bank with no code",
      {
        method: "bank",
        bankCode: " ",
        accountNumber: "0123456789",
        accountName: "A",
      },
    ],
    [
      "no account name",
      { method: "mpesa_till", tillNumber: "123456", accountName: "   " },
    ],
  ])("rejects %s", (_label, recipient) => {
    expect(() => toPaycrestRecipient(recipient, MEMO)).toThrow(
      InvalidRecipient,
    );
  });
});

describe("buildOrderRequest", () => {
  it("orders the quoted USDC to the recipient, refunding to the company wallet", () => {
    // #given
    const recipient = toPaycrestRecipient(
      {
        method: "mpesa_phone",
        phone: "+254712345678",
        accountName: "Jane Wanjiku",
      },
      MEMO,
    );

    // #when
    const request = buildOrderRequest({
      quote: {
        requestedKesCents: 149_950n,
        payoutKesCents: 150_000n,
        usdcAmount: 11_656_824n,
        rate: "128.68",
        providerIds: ["kVMyxKfB"],
      },
      recipient,
      reference: "payout-1",
      refundAddress: "0xCompanyWallet",
    });

    // #then
    expect(request).toEqual({
      amount: "11.656824",
      amountIn: "crypto",
      rate: "128.68",
      reference: "payout-1",
      transactionFeePayer: "customer",
      source: {
        type: "crypto",
        currency: "USDC",
        network: "base",
        refundAddress: "0xCompanyWallet",
      },
      destination: {
        type: "fiat",
        currency: "KES",
        country: "KE",
        providerIds: ["kVMyxKfB"],
        recipient,
      },
    });
  });
});
