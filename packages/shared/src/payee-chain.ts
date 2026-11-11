import { z } from "zod";

/**
 * The chain a USDC payee or withdrawal address receives on
 * (docs/decisions/near-main-chain.md). NEAR is paid straight from the
 * company wallet; Base and Solana are paid through NEAR Intents.
 */
export const PAYEE_CHAINS = ["near", "base", "solana"] as const;
export const payeeChainSchema = z.enum(PAYEE_CHAINS, {
  error: "Choose the chain the address is on: NEAR, Base or Solana.",
});
export type PayeeChain = z.infer<typeof payeeChainSchema>;

export const PAYEE_CHAIN_NAMES: Readonly<Record<PayeeChain, string>> = {
  near: "NEAR",
  base: "Base",
  solana: "Solana",
};

const NEAR_ACCOUNT_ID_MIN_LENGTH = 2;
const NEAR_ACCOUNT_ID_MAX_LENGTH = 64;
const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const EVM_SHAPED_NEAR_ACCOUNT = /^0x[0-9a-f]{40}$/;

/**
 * Whether `value` is a NEAR account ID: a 64-hex implicit account, or a
 * named account such as `acme.near`, 2 to 64 characters. Account IDs have no
 * uppercase form, so one with a capital letter is not an account.
 *
 * A lowercase EVM address is also a valid NEAR account ID, but here it is
 * far more likely a Base address pasted under the wrong chain, and USDC sent
 * to it on NEAR would not reach that Base wallet. It is refused.
 */
export function isNearAccountId(value: string): boolean {
  return (
    value.length >= NEAR_ACCOUNT_ID_MIN_LENGTH &&
    value.length <= NEAR_ACCOUNT_ID_MAX_LENGTH &&
    NEAR_ACCOUNT_ID.test(value) &&
    !EVM_SHAPED_NEAR_ACCOUNT.test(value)
  );
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether `value` has the form of an EVM address: `0x` and 40 hex digits.
 * This doesn't check a mixed-case address against its EIP-55 checksum; the
 * API does, before it saves one.
 */
export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_DIGITS = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]),
);
/** No 32-byte value takes more base58 characters than this. */
const BASE58_32_BYTES_MAX_LENGTH = 44;
const SOLANA_ADDRESS_BYTES = 32;

/**
 * The bytes a base58 string (Bitcoin alphabet) stands for, or null if it has
 * a character outside the alphabet. Meant for short values such as addresses
 * and hashes: the work grows with the square of the length.
 */
export function decodeBase58(value: string): Uint8Array | null {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_DIGITS.get(char);
    if (digit === undefined) return null;
    number = number * 58n + digit;
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  // Each leading "1" is a zero byte the number above can't carry.
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Whether `value` is a Solana address: base58 for exactly 32 bytes. Solana
 * addresses are case-sensitive, so they are never lowercased.
 */
export function isSolanaAddress(value: string): boolean {
  if (value.length === 0 || value.length > BASE58_32_BYTES_MAX_LENGTH) {
    return false;
  }
  return decodeBase58(value)?.length === SOLANA_ADDRESS_BYTES;
}

/** Whether `address` can receive on `chain`, exactly as written. */
export function isPayeeChainAddress(
  chain: PayeeChain,
  address: string,
): boolean {
  switch (chain) {
    case "near":
      return isNearAccountId(address);
    case "base":
      return isEvmAddress(address);
    case "solana":
      return isSolanaAddress(address);
  }
}

const NOT_AN_ADDRESS: Readonly<Record<PayeeChain, string>> = {
  near: "That isn't a NEAR account. Enter one like acme.near, or the 64-character account ID, in lowercase.",
  base: "That isn't a Base address. Enter 0x followed by 40 characters.",
  solana: "That isn't a Solana address. Check it for typos, or paste it again.",
};

/**
 * What to tell someone whose `address` can't receive on `chain`, or null
 * when it can.
 */
export function payeeChainAddressProblem(
  chain: PayeeChain,
  address: string,
): string | null {
  return isPayeeChainAddress(chain, address) ? null : NOT_AN_ADDRESS[chain];
}

const enterAddress = "Enter the address.";

/**
 * An address as typed or pasted, with the spaces around it removed. Whether
 * it fits its chain is checked with `payeeChainAddressProblem`, once the
 * chain is known.
 */
export const payeeAddressSchema = z
  .string({ error: enterAddress })
  .trim()
  .min(1, enterAddress);
