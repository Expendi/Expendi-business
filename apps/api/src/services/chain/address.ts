import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import type { PayeeChain } from "@expendi-business/shared";
import { isNearAccountId, isSolanaAddress } from "@expendi-business/shared";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `address` in its EIP-55 mixed-case form. */
export function toChecksumAddress(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  const mixed = [...hex]
    .map((char, index) =>
      Number.parseInt(hash.charAt(index), 16) >= 8 ? char.toUpperCase() : char,
    )
    .join("");
  return `0x${mixed}`;
}

/**
 * `raw` as a lowercased Base address, or `null` if it isn't one. A
 * mixed-case address must match its EIP-55 checksum, so one mistyped
 * character is caught; an all-lowercase or all-uppercase one carries no
 * checksum to check.
 */
export function normaliseBaseAddress(raw: string): string | null {
  const address = raw.trim();
  if (!HEX_ADDRESS.test(address)) return null;
  const hex = address.slice(2);
  const checksummed =
    hex === hex.toLowerCase() ||
    hex === hex.toUpperCase() ||
    address === toChecksumAddress(address);
  return checksummed ? `0x${hex.toLowerCase()}` : null;
}

/**
 * `raw` in the form an address on `chain` is stored, compared and paid in,
 * or `null` if it isn't one. Only a Base address is lowercased. A NEAR
 * account with a capital letter is refused rather than guessed at, and a
 * Solana address is case-sensitive, so both are kept exactly as given.
 */
export function normalisePayeeAddress(
  chain: PayeeChain,
  raw: string,
): string | null {
  const address = raw.trim();
  switch (chain) {
    case "base":
      return normaliseBaseAddress(address);
    case "near":
      return isNearAccountId(address) ? address : null;
    case "solana":
      return isSolanaAddress(address) ? address : null;
  }
}

/** What to tell someone whose address `normalisePayeeAddress` refused. */
export const INVALID_PAYEE_ADDRESS: Readonly<Record<PayeeChain, string>> = {
  near: "That NEAR account isn't valid. Enter one like acme.near, or the 64-character account ID, in lowercase.",
  base: "That Base address isn't valid. Check it for typos, or paste it again.",
  solana:
    "That Solana address isn't valid. Check it for typos, or paste it again.",
};
