import type { PayeeChain } from "./payee-chain.js";

/**
 * A NEAR transaction on Nearblocks. NEAR hashes are base58 and
 * case-sensitive, so the hash goes in exactly as given.
 */
export function nearTransactionUrl(txHash: string): string {
  return `https://nearblocks.io/txns/${encodeURIComponent(txHash)}`;
}

const BASE_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * A transaction on a payee chain's explorer, or null when no link is right:
 * Solana has no explorer here yet, and a Base hash that isn't `0x` and 64 hex
 * digits is not linked rather than sent to a page that can't show it. A NEAR
 * hash goes in exactly as given.
 */
export function payeeChainTransactionUrl(
  chain: PayeeChain,
  txHash: string,
): string | null {
  switch (chain) {
    case "near":
      return nearTransactionUrl(txHash);
    case "base":
      return BASE_TRANSACTION_HASH.test(txHash)
        ? `https://basescan.org/tx/${txHash}`
        : null;
    case "solana":
      return null;
  }
}
