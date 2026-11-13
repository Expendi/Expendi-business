/**
 * A NEAR transaction on Nearblocks. NEAR hashes are base58 and
 * case-sensitive, so the hash goes in exactly as given.
 */
export function nearTransactionUrl(txHash: string): string {
  return `https://nearblocks.io/txns/${encodeURIComponent(txHash)}`;
}
