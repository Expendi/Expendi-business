/**
 * Pretium's Base USDC settlement wallet. Pinned in code because the USDC is
 * sent before Pretium hears of the payout: the address must never come from
 * an API response at payment time. Readiness checks Pretium still reports it.
 */
export const PRETIUM_BASE_SETTLEMENT_ADDRESS =
  "0x8005ee53E57aB11E11eAA4EFe07Ee3835Dc02F98";
