const BASESCAN = "https://basescan.org";
const NEARBLOCKS = "https://nearblocks.io";

export const basescanAddressUrl = (address: string): string =>
  `${BASESCAN}/address/${address}`;

/** A transaction on Base (`0x…`) or on NEAR (a base58 hash), told apart by shape. */
export const transactionUrl = (hash: string): string =>
  hash.startsWith("0x")
    ? `${BASESCAN}/tx/${hash}`
    : `${NEARBLOCKS}/txns/${hash}`;
