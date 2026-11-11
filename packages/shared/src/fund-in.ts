import { z } from "zod";

/**
 * The chains a company can fund in from (docs/decisions/near-main-chain.md):
 * it sends USDC on one of these to a deposit address, and NEAR Intents
 * delivers USDC to its company wallet.
 */
export const FUND_IN_CHAINS = [
  "base",
  "ethereum",
  "arbitrum",
  "solana",
] as const;
export const fundInChainSchema = z.enum(FUND_IN_CHAINS, {
  error: "Choose the chain you are sending from.",
});
export type FundInChain = z.infer<typeof fundInChainSchema>;

export const FUND_IN_CHAIN_NAMES: Readonly<Record<FundInChain, string>> = {
  base: "Base",
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  solana: "Solana",
};

/**
 * `POST /organizations/:id/wallet/fund-ins`. There is no refund address to
 * give: a fund-in that can't be completed is refunded into the company's
 * own NEAR Intents account and returned to the company wallet from there.
 */
export const fundInRequestSchema = z.object({
  chain: fundInChainSchema,
  /** USDC base units (6 decimals). */
  amount: z
    .string({ error: "Enter an amount." })
    .regex(/^[1-9]\d{0,14}$/, "Enter an amount in USDC."),
});

export type FundInRequest = z.infer<typeof fundInRequestSchema>;

/**
 * - `awaiting_deposit`: nothing has reached the deposit address yet.
 * - `processing`: the deposit was seen and is on its way to the wallet.
 * - `completed`: USDC was delivered to the company wallet.
 * - `returning`: it couldn't be completed, and the deposit is on its way
 *   back to the company wallet through the company's NEAR Intents account.
 * - `returned`: that deposit reached the company wallet, as a deposit.
 * - `refunded`: the deposit went back to a refund address on the chain it
 *   came from (fund-ins started before refunds went to NEAR Intents).
 * - `failed`: it could not be completed; Expendi is looking into it.
 * - `expired`: the deadline passed with nothing deposited.
 */
export const FUND_IN_STATUSES = [
  "awaiting_deposit",
  "processing",
  "completed",
  "returning",
  "returned",
  "refunded",
  "failed",
  "expired",
] as const;
export const fundInStatusSchema = z.enum(FUND_IN_STATUSES);
export type FundInStatus = z.infer<typeof fundInStatusSchema>;

export const fundInSchema = z.object({
  id: z.uuid(),
  chain: fundInChainSchema,
  /** USDC base units to send to the deposit address. */
  amountIn: z.string().regex(/^\d+$/),
  /** USDC base units the company wallet is quoted to receive. */
  amountOut: z.string().regex(/^\d+$/),
  /** Where to send `amountIn`, on `chain`. */
  depositAddress: z.string(),
  /** A deposit after this is refunded instead of delivered. */
  deadline: z.iso.datetime(),
  status: fundInStatusSchema,
  createdAt: z.iso.datetime(),
});

export type FundIn = z.infer<typeof fundInSchema>;

/** `GET /organizations/:id/wallet/fund-ins`, newest first. */
export const fundInsResponseSchema = z.array(fundInSchema);
