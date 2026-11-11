import { describe, expect, it } from "vitest";

import { addressGroups, addressOnChain, shortAddress } from "./chain-display";

const NEAR_IMPLICIT =
  "8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c218f3a5b2c9d1e4f7a6b0c3d2e";
const BASE = "0x12AB7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99F3c";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("shortAddress", () => {
  it.each([
    ["a short NEAR account, whole", "alice.near", "alice.near"],
    [
      "a NEAR account of 24 characters, whole",
      "mwangaza-logistics.near1",
      "mwangaza-logistics.near1",
    ],
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
      "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
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

describe("addressGroups", () => {
  it("groups a Base address and a 64-character NEAR account in fours", () => {
    // #when
    const base = addressGroups(BASE);
    const near = addressGroups(NEAR_IMPLICIT);

    // #then
    expect({
      base: [base.prefix, base.groups.length, base.groups.join("")],
      near: [near.prefix, near.groups.length, near.groups.join("")],
    }).toEqual({
      base: ["0x", 10, BASE.slice(2)],
      near: [null, 16, NEAR_IMPLICIT],
    });
  });

  it("leaves a named NEAR account and a Solana address whole", () => {
    // #then
    expect([addressGroups("acme.near"), addressGroups(SOLANA)]).toEqual([
      { prefix: null, groups: ["acme.near"] },
      { prefix: null, groups: [SOLANA] },
    ]);
  });
});
