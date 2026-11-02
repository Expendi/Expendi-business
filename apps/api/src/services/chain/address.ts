import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

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
