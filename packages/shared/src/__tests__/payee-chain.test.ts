import { describe, expect, it } from "vitest";

import type { PayeeChain } from "../payee-chain.js";
import {
  decodeBase58,
  isEvmAddress,
  isNearAccountId,
  isPayeeChainAddress,
  isSolanaAddress,
  PAYEE_CHAINS,
  payeeChainAddressProblem,
} from "../payee-chain.js";
import { payeeDetailsSchema } from "../payee.js";
import { allowlistChangeSchema } from "../withdrawal.js";

const IMPLICIT_ACCOUNT = "ab".repeat(32);
const BASE_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_ADDRESS_CHECKSUMMED = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The USDC mint on Solana: 32 bytes. */
const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** 32 zero bytes: the Solana system program. */
const SOLANA_ALL_ONES = "1".repeat(32);
const BASE58_FOR_31_BYTES = "3guQgf9mkU1JiELnxmxNhoxCPZpy6n4YUcwuWp8av8";
const BASE58_FOR_33_BYTES = "uNFJp1ZGEk96345h6Uzk2aw95s1GfgWuzwSELDBXFtXU";

describe("isNearAccountId", () => {
  it.each([
    ["a 64-hex implicit account", IMPLICIT_ACCOUNT],
    ["a named account", "acme.near"],
    ["a sub-account", "payroll.acme.near"],
    ["a top-level account", "near"],
    ["the shortest account", "ab"],
    ["a name with separators", "acme-pay_roll.near"],
    ["the longest account", `${"a".repeat(59)}.near`],
  ])("accepts %s", (_name, accountId) => {
    expect(isNearAccountId(accountId)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["one character", "a"],
    ["65 characters", "a".repeat(65)],
    ["a capital letter", "Acme.near"],
    [
      "a lowercase Base address pasted under the wrong chain",
      "0x2a1b84c7b8dc9fac24505ab87a41b21e654017bd",
    ],
    ["an implicit account in capitals", IMPLICIT_ACCOUNT.toUpperCase()],
    ["a leading dot", ".acme.near"],
    ["a trailing dot", "acme.near."],
    ["two dots in a row", "acme..near"],
    ["a leading separator", "-acme.near"],
    ["two separators in a row", "ac--me.near"],
    ["a space inside", "acme .near"],
    ["a space around it", " acme.near"],
    ["a line break", "acme.near\n"],
    ["an at sign", "acme@near"],
    ["a letter outside ASCII", "acmé.near"],
    ["a lookalike letter", "асме.near"],
    ["a null byte", "acme\u0000.near"],
  ])("refuses %s", (_name, accountId) => {
    expect(isNearAccountId(accountId)).toBe(false);
  });

  it("answers quickly for a very long hostile value", () => {
    // #given
    const hostile = `${"a-".repeat(200_000)}!`;

    // #when
    const started = performance.now();
    const accepted = isNearAccountId(hostile);

    // #then
    expect(accepted).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("isEvmAddress", () => {
  it.each([
    ["all lowercase", BASE_ADDRESS],
    ["EIP-55 mixed case", BASE_ADDRESS_CHECKSUMMED],
  ])("accepts an address in %s", (_name, address) => {
    expect(isEvmAddress(address)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["no 0x", BASE_ADDRESS.slice(2)],
    ["a capital X", `0X${BASE_ADDRESS.slice(2)}`],
    ["39 hex digits", BASE_ADDRESS.slice(0, -1)],
    ["41 hex digits", `${BASE_ADDRESS}0`],
    ["a letter that isn't hex", `0x${"g".repeat(40)}`],
    ["a line break after it", `${BASE_ADDRESS}\n`],
    ["a transaction hash", `0x${"ab".repeat(32)}`],
  ])("refuses %s", (_name, address) => {
    expect(isEvmAddress(address)).toBe(false);
  });
});

describe("decodeBase58", () => {
  it("keeps each leading 1 as a zero byte", () => {
    expect(decodeBase58("112")).toEqual(Uint8Array.from([0, 0, 1]));
  });

  it("decodes an empty string to no bytes", () => {
    expect(decodeBase58("")).toEqual(new Uint8Array());
  });

  it.each([["0"], ["O"], ["I"], ["l"], ["+"], [" "]])(
    "refuses %j, which is outside the alphabet",
    (char) => {
      expect(decodeBase58(`2${char}2`)).toBeNull();
    },
  );
});

describe("isSolanaAddress", () => {
  it.each([
    ["an address", SOLANA_ADDRESS],
    ["32 zero bytes", SOLANA_ALL_ONES],
  ])("accepts %s", (_name, address) => {
    expect(isSolanaAddress(address)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["base58 for 31 bytes", BASE58_FOR_31_BYTES],
    ["base58 for 33 bytes", BASE58_FOR_33_BYTES],
    ["31 zero bytes", "1".repeat(31)],
    ["33 zero bytes", "1".repeat(33)],
    ["a character outside the alphabet", `${SOLANA_ADDRESS.slice(0, -1)}0`],
    ["a space around it", ` ${SOLANA_ADDRESS}`],
    ["a Base address", BASE_ADDRESS],
    ["a NEAR implicit account", IMPLICIT_ACCOUNT],
    ["a transaction signature", "5".repeat(88)],
  ])("refuses %s", (_name, address) => {
    expect(isSolanaAddress(address)).toBe(false);
  });

  it("doesn't decode a very long hostile value", () => {
    // #given
    const hostile = "2".repeat(2_000_000);

    // #when
    const started = performance.now();
    const accepted = isSolanaAddress(hostile);

    // #then
    expect(accepted).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("tells two addresses apart by case alone", () => {
    // #given
    const lowercased = SOLANA_ADDRESS.toLowerCase();

    // #then
    expect(lowercased).not.toBe(SOLANA_ADDRESS);
    expect(decodeBase58(lowercased)).not.toEqual(decodeBase58(SOLANA_ADDRESS));
  });
});

describe("isPayeeChainAddress", () => {
  const own: Record<PayeeChain, string> = {
    near: "acme.near",
    base: BASE_ADDRESS_CHECKSUMMED,
    solana: SOLANA_ADDRESS,
  };

  it.each(PAYEE_CHAINS)("accepts a %s address on its own chain", (chain) => {
    expect(isPayeeChainAddress(chain, own[chain])).toBe(true);
    expect(payeeChainAddressProblem(chain, own[chain])).toBeNull();
  });

  it.each([
    ["near", own.base, "That isn't a NEAR account."],
    ["near", own.solana, "That isn't a NEAR account."],
    ["base", own.near, "That isn't a Base address."],
    ["base", own.solana, "That isn't a Base address."],
    ["solana", own.near, "That isn't a Solana address."],
    ["solana", own.base, "That isn't a Solana address."],
  ] as const)(
    "refuses on %s an address from another chain",
    (chain, address, message) => {
      expect(isPayeeChainAddress(chain, address)).toBe(false);
      expect(payeeChainAddressProblem(chain, address)).toContain(message);
    },
  );
});

describe("a USDC payee's details", () => {
  it.each([
    ["near", "acme.near"],
    ["base", BASE_ADDRESS],
    ["solana", SOLANA_ADDRESS],
  ] as const)("accepts a %s address with its chain", (chain, address) => {
    // #when
    const parsed = payeeDetailsSchema.parse({
      method: "usdc",
      chain,
      address: `  ${address} `,
    });

    // #then
    expect(parsed).toEqual({ method: "usdc", chain, address });
  });

  it("needs a chain", () => {
    // #when
    const parsed = payeeDetailsSchema.safeParse({
      method: "usdc",
      address: BASE_ADDRESS,
    });

    // #then
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ["chain"],
      message: "Choose the chain the address is on: NEAR, Base or Solana.",
    });
  });

  it.each([
    ["near", BASE_ADDRESS_CHECKSUMMED, "That isn't a NEAR account."],
    ["base", "acme.near", "That isn't a Base address."],
    ["solana", BASE_ADDRESS, "That isn't a Solana address."],
  ] as const)(
    "says what is wrong with an address that isn't on %s",
    (chain, address, message) => {
      // #when
      const parsed = payeeDetailsSchema.safeParse({
        method: "usdc",
        chain,
        address,
      });

      // #then
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(["address"]);
      expect(parsed.error?.issues[0]?.message).toContain(message);
    },
  );

  it("asks for an address when there is none", () => {
    // #when
    const parsed = payeeDetailsSchema.safeParse({
      method: "usdc",
      chain: "near",
      address: "   ",
    });

    // #then
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ["address"],
      message: "Enter the address.",
    });
  });
});

describe("adding a withdrawal address", () => {
  it.each([
    ["near", IMPLICIT_ACCOUNT],
    ["base", BASE_ADDRESS_CHECKSUMMED],
    ["solana", SOLANA_ADDRESS],
  ] as const)("accepts a %s address with its chain", (chain, address) => {
    // #when
    const parsed = allowlistChangeSchema.parse({
      action: "add",
      chain,
      address,
      label: " Treasury ",
    });

    // #then
    expect(parsed).toEqual({
      action: "add",
      chain,
      address,
      label: "Treasury",
    });
  });

  it.each([
    ["near", "Acme.near", "That isn't a NEAR account."],
    ["base", `${BASE_ADDRESS}0`, "That isn't a Base address."],
    ["solana", BASE58_FOR_31_BYTES, "That isn't a Solana address."],
  ] as const)(
    "refuses an address that isn't on %s",
    (chain, address, message) => {
      // #when
      const parsed = allowlistChangeSchema.safeParse({
        action: "add",
        chain,
        address,
        label: "Treasury",
      });

      // #then
      expect(parsed.error?.issues[0]?.path).toEqual(["address"]);
      expect(parsed.error?.issues[0]?.message).toContain(message);
    },
  );

  it("needs a chain", () => {
    // #when
    const parsed = allowlistChangeSchema.safeParse({
      action: "add",
      address: BASE_ADDRESS,
      label: "Treasury",
    });

    // #then
    expect(parsed.error?.issues[0]?.path).toEqual(["chain"]);
  });
});
