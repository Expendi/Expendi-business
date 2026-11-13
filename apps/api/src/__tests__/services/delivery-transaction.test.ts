import { describe, expect, it } from "vitest";

import type { Payout } from "../../db/schema/index.js";
import { deliveryTransactionOf } from "../../services/wallet/history.js";
import { withdrawalTransactionOf } from "../../services/withdrawal/withdrawals.js";

type Facts = Parameters<typeof withdrawalTransactionOf>[0];

const NEAR_HASH = "6mKzv7RfQ9cYw2PqL8nXbT3jDe4HsUa1VgCoNiEp5MtY";
const BASE_HASH = `0x${"ab".repeat(32)}`;
const usdcRecipient = (
  chain: "near" | "base" | "solana",
): Payout["recipient"] => ({
  method: "usdc",
  chain,
  address: chain === "base" ? `0x${"b".repeat(40)}` : "acme.near",
  accountName: "Acme",
});

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  provider: "onchain",
  status: "paid",
  recipient: usdcRecipient("base"),
  deliveryQuoteId: "11111111-1111-4111-8111-111111111111",
  providerReference: BASE_HASH,
  txHash: null,
  ...overrides,
});

describe("deliveryTransactionOf", () => {
  it("is the payee chain's transaction of a paid USDC payout a quote delivered", () => {
    // #when
    const delivery = deliveryTransactionOf(facts());

    // #then
    expect(delivery).toEqual({ txHash: BASE_HASH, chain: "base" });
  });

  it.each([
    ["not paid yet", { status: "paying" as const }],
    ["sent straight from the company wallet", { deliveryQuoteId: null }],
    ["without a reference", { providerReference: null }],
    ["with an empty reference", { providerReference: "" }],
    [
      "a cash-out, whose reference is a provider's receipt",
      {
        provider: "pretium" as const,
        recipient: {
          method: "mpesa_till" as const,
          tillNumber: "123456",
          accountName: "Acme",
        },
      },
    ],
  ])("is nothing for a payout %s", (_name, overrides) => {
    // #when
    const delivery = deliveryTransactionOf(facts(overrides));

    // #then
    expect(delivery).toBeNull();
  });
});

describe("withdrawalTransactionOf", () => {
  it("is the payee chain's delivery when the company sent nothing of its own", () => {
    // #when
    const view = withdrawalTransactionOf(facts());

    // #then
    expect(view).toEqual({ txHash: BASE_HASH, txChain: "base" });
  });

  it("keeps the company's own deposit, with no chain named, for a quote-delivered payout it sent", () => {
    // #when
    const view = withdrawalTransactionOf(facts({ txHash: NEAR_HASH }));

    // #then
    expect(view).toEqual({ txHash: NEAR_HASH });
  });

  it("keeps a direct send's hash as it was, with no chain named, case included", () => {
    // #when
    const view = withdrawalTransactionOf(
      facts({
        txHash: NEAR_HASH,
        deliveryQuoteId: null,
        providerReference: NEAR_HASH,
        recipient: usdcRecipient("near"),
      }),
    );

    // #then
    expect(view).toEqual({ txHash: NEAR_HASH });
  });

  it("has no transaction while there is none", () => {
    // #when
    const view = withdrawalTransactionOf(
      facts({ status: "funding", providerReference: null }),
    );

    // #then
    expect(view).toEqual({ txHash: null });
  });
});
