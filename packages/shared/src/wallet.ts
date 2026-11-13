import { z } from "zod";

import { cashOutAmountLimitsSchema } from "./cash-out-limits.js";

/**
 * The chain a company wallet is on. NEAR is the main chain and what every
 * new wallet gets; `base` remains for wallets made before the move
 * (docs/decisions/near-main-chain.md).
 */
export const WALLET_CHAINS = ["base", "near"] as const;
export const walletChainSchema = z.enum(WALLET_CHAINS);
export type WalletChain = z.infer<typeof walletChainSchema>;

/** The chain a new company wallet is created on. */
export const MAIN_CHAIN: WalletChain = "near";

/**
 * `creating` until the company wallet and its transit wallet both exist and
 * the company wallet's account is usable on chain.
 */
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

/**
 * Money in adds to the balance; payouts and withdrawals take from it. The
 * two Treasury types are the company's own money leaving for, or coming back
 * from, its Treasury wallet: `to_treasury` is always negative, `from_treasury`
 * always positive.
 */
export const WALLET_TRANSACTION_TYPES = [
  "deposit",
  "payout",
  "refund",
  "withdrawal",
  "topup",
  "to_treasury",
  "from_treasury",
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
   * The balance in KES cents at the active cash-out provider's rate now,
   * rounded down; null while that rate is unavailable.
   */
  kesEquivalent: z
    .object({ kesCents: z.string().regex(/^\d+$/), rate: z.string() })
    .nullable(),
  /**
   * The smallest and largest amount one cash-out can send right now, for a
   * KES bill's form to state. Always sent; optional only for clients built
   * before it.
   */
  cashOutLimits: cashOutAmountLimitsSchema.optional(),
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
