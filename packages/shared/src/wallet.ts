import { z } from "zod";

export const WALLET_CHAINS = ["base"] as const;
export const walletChainSchema = z.enum(WALLET_CHAINS);
export type WalletChain = z.infer<typeof walletChainSchema>;

/** Money in adds to the balance; payouts and withdrawals take from it. */
export const WALLET_TRANSACTION_TYPES = [
  "deposit",
  "payout",
  "refund",
  "withdrawal",
  "topup",
] as const;
export const walletTransactionTypeSchema = z.enum(WALLET_TRANSACTION_TYPES);
export type WalletTransactionType = z.infer<typeof walletTransactionTypeSchema>;

/** USDC amounts are 6-decimal base units, serialised as integer strings. */
const usdcBaseUnits = z.string().regex(/^-?\d+$/);

export const walletResponseSchema = z.object({
  address: z.string(),
  chain: walletChainSchema,
  usdcBalance: usdcBaseUnits,
  /**
   * The balance in KES cents at Paycrest's current sell rate, rounded down;
   * null while Paycrest is unavailable.
   */
  kesEquivalent: z
    .object({ kesCents: z.string().regex(/^\d+$/), rate: z.string() })
    .nullable(),
});

export type WalletResponse = z.infer<typeof walletResponseSchema>;
