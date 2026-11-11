import type { PayeeChain } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

/**
 * How addresses, NEAR accounts and transaction hashes are shown. Nothing
 * here changes their case: NEAR hashes and Solana addresses are
 * case-sensitive.
 */

const SHOWN_WHOLE_UP_TO = 24;

/**
 * Enough of an address or transaction hash to recognise it: `0x1234…abcd`.
 * A short NEAR account such as `alice.near` is shown whole, and a long
 * named one keeps the end of its name: `accounts…ics.near`.
 */
export function shortAddress(address: string): string {
  if (address.length <= SHOWN_WHOLE_UP_TO) return address;
  return address.includes(".")
    ? `${address.slice(0, 8)}…${address.slice(-8)}`
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "0x1234…abcd on Base", "alice.near on NEAR". */
export function addressOnChain(chain: PayeeChain, address: string): string {
  return `${shortAddress(address)} on ${PAYEE_CHAIN_NAMES[chain]}`;
}

/** What the address field is called for each payee chain. */
export const ADDRESS_LABELS: Readonly<Record<PayeeChain, string>> = {
  near: "NEAR account",
  base: "Base address",
  solana: "Solana address",
};

export const ADDRESS_PLACEHOLDERS: Readonly<
  Partial<Record<PayeeChain, string>>
> = {
  near: "e.g. acme.near",
  base: "0x…",
};
