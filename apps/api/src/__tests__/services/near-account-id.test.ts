import { USDC as MAINNET_USDC } from "near-api-js/tokens/mainnet";
import { USDC as TESTNET_USDC } from "near-api-js/tokens/testnet";
import { describe, expect, it } from "vitest";

import {
  implicitAccountPublicKey,
  normaliseNearAccountId,
  USDC_NEAR_CONTRACT_IDS,
} from "../../services/chain/near.js";

const IMPLICIT =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("NEAR account IDs", () => {
  it.each([
    [IMPLICIT],
    ["alice.near"],
    ["a1.b-c_d.near"],
    ["ab"],
    ["usdc.fakes.testnet"],
    ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    ["a".repeat(64)],
  ])("accepts %s", (accountId) => {
    // #when
    const normalised = normaliseNearAccountId(accountId);

    // #then
    expect(normalised).toBe(accountId);
  });

  it("trims the whitespace around a pasted account ID", () => {
    // #when
    const normalised = normaliseNearAccountId(`  alice.near\n`);

    // #then
    expect(normalised).toBe("alice.near");
  });

  it.each([
    [""],
    ["a"],
    ["a".repeat(65)],
    ["Alice.near"],
    [IMPLICIT.toUpperCase()],
    ["alice..near"],
    [".near"],
    ["near."],
    ["a--b.near"],
    ["-alice.near"],
    ["alice_.near"],
    ["alice near"],
    ["alice@near"],
    ["ålice.near"],
    [`${IMPLICIT}0`],
  ])("rejects %j", (raw) => {
    // #when
    const normalised = normaliseNearAccountId(raw);

    // #then
    expect(normalised).toBeNull();
  });

  it("reads an implicit account's public key from its ID", () => {
    // #when
    const publicKey = implicitAccountPublicKey(IMPLICIT);

    // #then
    expect(Buffer.from(publicKey.data).toString("hex")).toBe(IMPLICIT);
  });

  it("has no public key to read from a named account", () => {
    // #when
    const read = () => implicitAccountPublicKey("alice.near");

    // #then
    expect(read).toThrow(RangeError);
  });
});

describe("USDC on NEAR", () => {
  it("is the contract near-api-js lists for each network", () => {
    // #then
    expect(USDC_NEAR_CONTRACT_IDS).toEqual({
      mainnet: MAINNET_USDC.accountId,
      testnet: TESTNET_USDC.accountId,
    });
  });

  it("is Circle's contract on mainnet", () => {
    // #then
    expect(USDC_NEAR_CONTRACT_IDS.mainnet).toBe(
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    );
  });
});
