import { describe, expect, it } from "vitest";

import type { ExpectedOrder } from "../../services/paycrest/order-safety.js";
import type { PaycrestOrder } from "../../services/paycrest/paycrest-client.js";
import type { KesRecipient } from "../../services/paycrest/recipient.js";
import { checkOrder } from "../../services/paycrest/order-safety.js";
import { toPaycrestRecipient } from "../../services/paycrest/recipient.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const COMPANY_WALLET = "0x1111111111111111111111111111111111111111";
const DEPOSIT_ADDRESS = "0x2222222222222222222222222222222222222222";

const QUOTE = {
  requestedKesCents: 149_950n,
  payoutKesCents: 150_000n,
  usdcAmount: 11_656_824n,
  rate: "128.68",
  providerIds: ["kVMyxKfB"],
} as const;

function expectedFor(recipient: KesRecipient): ExpectedOrder {
  return {
    reference: "payout-1",
    refundAddress: COMPANY_WALLET,
    recipient: toPaycrestRecipient(recipient, "Expendi Business payout"),
    quote: QUOTE,
    maxDebitUsdc: 11_756_824n,
    now: NOW,
  };
}

const PHONE: KesRecipient = {
  method: "mpesa_phone",
  phone: "+254712345678",
  accountName: "Jane Wanjiku",
};
const PAYBILL: KesRecipient = {
  method: "mpesa_paybill",
  paybillNumber: "888880",
  accountReference: "ACC-1029",
  accountName: "Kenya Power",
};

/** The order Paycrest returns when everything is right. */
function safeOrder(expected: ExpectedOrder): PaycrestOrder {
  return {
    id: "order-1",
    status: "initiated",
    direction: "offramp",
    amount: "11.656824",
    rate: "128.68",
    reference: expected.reference,
    transactionFee: "0.02",
    senderFee: "0",
    source: {
      type: "crypto",
      currency: "USDC",
      network: "base",
      refundAddress: COMPANY_WALLET,
    },
    destination: {
      type: "fiat",
      currency: "KES",
      country: "KE",
      recipient: { ...expected.recipient },
    },
    providerAccount: {
      network: "base",
      receiveAddress: DEPOSIT_ADDRESS,
      validUntil: new Date(NOW + 30 * 60_000).toISOString(),
      amountToTransfer: "11.676824",
      currency: "USDC",
    },
  };
}

function withDeposit(
  order: PaycrestOrder,
  changes: Partial<NonNullable<PaycrestOrder["providerAccount"]>>,
): PaycrestOrder {
  if (!order.providerAccount) throw new Error("fixture has no deposit");
  return {
    ...order,
    providerAccount: { ...order.providerAccount, ...changes },
  };
}

const kindOf = (order: PaycrestOrder, expected: ExpectedOrder) =>
  checkOrder(order, expected)?.kind ?? "safe";

describe("checkOrder", () => {
  it("accepts an order that matches the payout exactly", () => {
    const expected = expectedFor(PHONE);
    expect(checkOrder(safeOrder(expected), expected)).toBeNull();
  });

  it("accepts a matching Paybill order", () => {
    const expected = expectedFor(PAYBILL);
    expect(checkOrder(safeOrder(expected), expected)).toBeNull();
  });

  describe("rejects an unsafe order, and nothing is sent", () => {
    const expected = expectedFor(PHONE);
    const order = safeOrder(expected);

    it.each<[string, PaycrestOrder]>([
      [
        "a deposit on another network",
        withDeposit(order, { network: "ethereum" }),
      ],
      ["a deposit in another token", withDeposit(order, { currency: "USDT" })],
      [
        "a deposit address equal to the refund address",
        withDeposit(order, {
          receiveAddress: COMPANY_WALLET.toUpperCase().replace("0X", "0x"),
        }),
      ],
      [
        "the zero address",
        withDeposit(order, { receiveAddress: `0x${"0".repeat(40)}` }),
      ],
      [
        "a malformed deposit address",
        withDeposit(order, { receiveAddress: "0x1234" }),
      ],
      [
        "deposit instructions already expired",
        withDeposit(order, { validUntil: new Date(NOW - 1_000).toISOString() }),
      ],
      [
        "deposit instructions expiring within 2 minutes",
        withDeposit(order, {
          validUntil: new Date(NOW + 60_000).toISOString(),
        }),
      ],
      ["an unparseable expiry", withDeposit(order, { validUntil: "soon" })],
      ["a memo on the deposit", withDeposit(order, { memo: "tag-123" })],
      ["no deposit instructions", { ...order, providerAccount: null }],
      [
        "refunds going somewhere else",
        {
          ...order,
          source: { ...order.source, refundAddress: DEPOSIT_ADDRESS },
        },
      ],
      [
        "a source on another network",
        { ...order, source: { ...order.source, network: "tron" } },
      ],
      [
        "another recipient account",
        {
          ...order,
          destination: {
            ...order.destination,
            recipient: {
              ...order.destination.recipient,
              accountIdentifier: "254700000000",
            },
          },
        },
      ],
      [
        "another institution",
        {
          ...order,
          destination: {
            ...order.destination,
            recipient: {
              ...order.destination.recipient,
              institution: "AIRTKEPC",
            },
          },
        },
      ],
      [
        "a Till channel for an M-Pesa number",
        {
          ...order,
          destination: {
            ...order.destination,
            recipient: {
              ...order.destination.recipient,
              metadata: { channel: "Till" },
            },
          },
        },
      ],
      [
        "another currency",
        { ...order, destination: { ...order.destination, currency: "UGX" } },
      ],
      ["another reference", { ...order, reference: "payout-2" }],
      ["an order past initiated", { ...order, status: "deposited" }],
      ["an on-ramp order", { ...order, direction: "onramp" }],
    ])("%s", (_label, unsafe) => {
      expect(kindOf(unsafe, expected)).toBe("unsafe");
    });
  });

  it("rejects a Paybill order for another business number", () => {
    // #given
    const expected = expectedFor(PAYBILL);
    const order = safeOrder(expected);
    const other = {
      ...order,
      destination: {
        ...order.destination,
        recipient: {
          ...order.destination.recipient,
          metadata: { channel: "Paybill", businessNumber: "400200" },
        },
      },
    };

    // #then
    expect(kindOf(other, expected)).toBe("unsafe");
  });

  describe("asks for a new quote when the payout is no longer covered", () => {
    const expected = expectedFor(PHONE);
    const order = safeOrder(expected);

    it("when the rate dropped more than 0.5%", () => {
      expect(kindOf({ ...order, rate: "128.0" }, expected)).toBe(
        "quote_changed",
      );
    });

    it("when the rate dropped even slightly below what the amount needs", () => {
      // 11.656824 × 128.67 = 1499.89: one shilling short on M-Pesa
      expect(kindOf({ ...order, rate: "128.67" }, expected)).toBe(
        "quote_changed",
      );
    });
  });

  describe("refuses to send more USDC than was approved", () => {
    const expected = expectedFor(PHONE);
    const order = safeOrder(expected);

    it.each<[string, PaycrestOrder]>([
      [
        "a larger order amount",
        withDeposit(
          { ...order, amount: "11.756824" },
          { amountToTransfer: "11.776824" },
        ),
      ],
      ["a sender fee", { ...order, senderFee: "0.01" }],
      [
        "a deposit above amount plus fee",
        withDeposit(order, { amountToTransfer: "11.68" }),
      ],
      [
        "a deposit above the approved maximum",
        withDeposit(
          { ...order, transactionFee: "0.2" },
          { amountToTransfer: "11.856824" },
        ),
      ],
    ])("%s", (_label, tooMuch) => {
      expect(kindOf(tooMuch, expected)).toBe("over_approved_debit");
    });
  });
});
