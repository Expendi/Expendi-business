import { describe, expect, it } from "vitest";

import { addressToAdd } from "./allowed-addresses";
import { isReviewedWithdrawal } from "./wallet-api";

const NEAR_IMPLICIT =
  "8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c218f3a5b2c9d1e4f7a6b0c3d2e";
const BASE = "0x12ab7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99f3c";
const CHECKSUMMED_BASE = "0x12Ab7c3E9f04d5B6a8c1e2f3d4b5a6c7e8f99F3c";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("adding an allowed address", () => {
  it("sends the payee chain with the address, kept as written", () => {
    // #when
    const changes = [
      addressToAdd("near", "Treasury", " acme.near "),
      addressToAdd("near", "Cold storage", NEAR_IMPLICIT),
      addressToAdd("base", "Coinbase", BASE),
      addressToAdd("solana", "Phantom", SOLANA),
    ];

    // #then
    expect(changes).toEqual([
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
          chain: "near",
          label: "Cold storage",
          address: NEAR_IMPLICIT,
        },
      },
      {
        ok: true,
        change: {
          action: "add",
          chain: "base",
          label: "Coinbase",
          address: BASE,
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
    // #when
    const refused = [
      addressToAdd("near", "Treasury", CHECKSUMMED_BASE),
      addressToAdd("near", "Treasury", "Acme.near"),
      addressToAdd("base", "Treasury", "acme.near"),
      addressToAdd("solana", "Treasury", BASE),
      addressToAdd("near", "", ""),
    ];

    // #then
    expect(refused).toEqual([
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
          address:
            "That isn't a Solana address. Check it for typos, or paste it again.",
        },
      },
      {
        ok: false,
        errors: {
          label: "Give the address a name.",
          address: "Enter the address.",
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
