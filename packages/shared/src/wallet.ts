import { z } from "zod";

export const WALLET_CHAINS = ["base"] as const;
export const walletChainSchema = z.enum(WALLET_CHAINS);
export type WalletChain = z.infer<typeof walletChainSchema>;

/** `creating` until both the Privy policy and the wallet exist. */
export const WALLET_STATUSES = ["creating", "active"] as const;
export const walletStatusSchema = z.enum(WALLET_STATUSES);
export type WalletStatus = z.infer<typeof walletStatusSchema>;

/**
 * Whether a company's wallet is ready for deposits: `active` once it exists
 * and deposits to it are watched. While it's `creating`,
 * `POST /organizations/:id/wallet` resumes the setup.
 */
export const walletSetupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), address: z.string() }),
  z.object({ status: z.literal("creating"), address: z.null() }),
]);

export type WalletSetup = z.infer<typeof walletSetupSchema>;

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

export const activeWalletSchema = z.object({
  status: z.literal("active"),
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

export type ActiveWallet = z.infer<typeof activeWalletSchema>;

/**
 * `GET /organizations/:id/wallet`. While it's `creating` there's no address
 * to deposit to yet; `POST` to the same path resumes the setup.
 */
export const walletResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("creating") }),
  activeWalletSchema,
]);

export type WalletResponse = z.infer<typeof walletResponseSchema>;
