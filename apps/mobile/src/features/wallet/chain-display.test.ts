import { describe, expect, it } from "vitest";

import type { WalletHistoryItem } from "@expendi-business/shared";

import { addressToAdd } from "./allowlist-change";
import { addressOnChain, shortAddress } from "./chain-display";
import { describeCounterparty } from "./history-display";
import { isReviewedWithdrawal } from "./withdrawal-check";

const NEAR_IMPLICIT =
  "8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c218f3a5b2c9d1e4f7a6b0c3d2e";
const BASE = "0x12AB7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99F3c";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const NEAR_HASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("shortAddress", () => {
  it.each([
    ["a short NEAR account, whole", "alice.near", "alice.near"],
    [
      "a long named NEAR account, with the end of its name",
      "accounts-payable.mwangaza-logistics.near",
      "accounts…ics.near",
    ],
    ["a 64-character NEAR account", NEAR_IMPLICIT, "8f3a5b…3d2e"],
    ["a Base address, in the case it was given", BASE, "0x12AB…9F3c"],
    ["a Solana address, in the case it was given", SOLANA, "7xKXtg…gAsU"],
    [
      "a NEAR transaction hash, in the case it was given",
      NEAR_HASH,
      "9xQeWv…VFin",
    ],
  ])("shows %s", (_what, address, expected) => {
    // #then
    expect(shortAddress(address)).toBe(expected);
  });
});

describe("addressOnChain", () => {
  it("names the payee chain after the address", () => {
    // #then
    expect([
      addressOnChain("near", "alice.near"),
      addressOnChain("base", BASE),
      addressOnChain("solana", SOLANA),
    ]).toEqual([
      "alice.near on NEAR",
      "0x12AB…9F3c on Base",
      "7xKXtg…gAsU on Solana",
    ]);
  });
});

describe("adding a withdrawal address", () => {
  it("sends the payee chain with the address, kept as written", () => {
    // #then
    expect([
      addressToAdd("near", "Treasury", " acme.near "),
      addressToAdd("solana", "Phantom", SOLANA),
    ]).toEqual([
      {
        ok: true,
        change: {
          action: "add",
          chain: "near",
          label: "Treasury",
          address: "acme.near",
        },
      },
      {
        ok: true,
        change: {
          action: "add",
          chain: "solana",
          label: "Phantom",
          address: SOLANA,
        },
      },
    ]);
  });

  it("refuses an address the chosen chain can't pay, in that chain's words", () => {
    // #then
    expect([
      addressToAdd("near", "Treasury", BASE),
      addressToAdd("base", "Treasury", "acme.near"),
      addressToAdd("solana", "", BASE),
    ]).toEqual([
      {
        ok: false,
        errors: {
          address:
            "That isn't a NEAR account. Enter one like acme.near, or the 64-character account ID, in lowercase.",
        },
      },
      {
        ok: false,
        errors: {
          address:
            "That isn't a Base address. Enter 0x followed by 40 characters.",
        },
      },
      {
        ok: false,
        errors: {
          label: "Give the address a name.",
          address:
            "That isn't a Solana address. Check it for typos, or paste it again.",
        },
      },
    ]);
  });
});

describe("signing a withdrawal", () => {
  const reviewed = {
    chain: "solana",
    address: SOLANA,
    amountUsdc: "5000000",
  } as const;

  it("accepts only the chain, address and amount the admin reviewed", () => {
    // #then
    expect([
      isReviewedWithdrawal(reviewed, reviewed),
      isReviewedWithdrawal({ ...reviewed, amountUsdc: "5000001" }, reviewed),
      isReviewedWithdrawal({ ...reviewed, chain: "near" }, reviewed),
      isReviewedWithdrawal(
        { ...reviewed, address: SOLANA.toLowerCase() },
        reviewed,
      ),
    ]).toEqual([true, false, false, false]);
  });
});

describe("a history row's counterparty", () => {
  const deposit: WalletHistoryItem = {
    id: "00000000-0000-4000-8000-000000000001",
    type: "deposit",
    usdcAmount: "6000000000",
    chain: "near",
    txHash: NEAR_HASH,
    counterpartyAddress: "mwangaza-treasury.near",
    createdAt: "2026-11-05T13:42:00.000Z",
    payout: null,
  };
  const withdrawal: WalletHistoryItem = {
    ...deposit,
    type: "withdrawal",
    usdcAmount: "-2000000000",
    counterpartyAddress: SOLANA,
    payout: {
      id: "00000000-0000-4000-8000-000000000002",
      subjectType: "withdrawal",
      method: "usdc",
      recipientName: "Phantom",
      recipientDetail: SOLANA,
      recipientChain: "solana",
      amountKesCents: "25800000",
      status: "paid",
      subjectId: "00000000-0000-4000-8000-000000000003",
      payrollRunId: null,
      approvalId: null,
      approvedAt: null,
      paidAt: null,
      categoryName: null,
      paymentReceipts: [],
      rate: null,
      failureReason: null,
    },
  };

  it("shows a NEAR sender and names a USDC recipient's payee chain", () => {
    // #then
    expect([
      describeCounterparty(deposit),
      describeCounterparty(withdrawal),
      describeCounterparty({
        ...deposit,
        chain: "base",
        counterpartyAddress: BASE,
      }),
    ]).toEqual([
      "From mwangaza-treasury.near",
      "Phantom · 7xKXtg…gAsU on Solana",
      "From 0x12AB…9F3c",
    ]);
  });
});
