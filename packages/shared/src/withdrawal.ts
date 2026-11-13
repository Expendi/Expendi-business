import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import {
  payeeAddressSchema,
  payeeChainAddressProblem,
  payeeChainSchema,
} from "./payee-chain.js";
import { payoutStatusSchema } from "./wallet-history.js";

export const WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH = 60;

/** One address on the company's allowlist (spec §6.9). */
export const withdrawalAddressSchema = z.object({
  id: z.uuid(),
  /** The payee chain the address receives on. */
  chain: payeeChainSchema,
  /**
   * As it is paid: a Base address lowercased, a NEAR account or a Solana
   * address exactly as given (a Solana address is case-sensitive).
   */
  address: z.string(),
  label: z.string(),
  confirmedAt: z.iso.datetime(),
});

export type WithdrawalAddress = z.infer<typeof withdrawalAddressSchema>;

/** `GET /organizations/:id/withdrawal-addresses`, oldest first. */
export const withdrawalAddressesResponseSchema = z.array(
  withdrawalAddressSchema,
);

/** `POST …/withdrawal-addresses/changes`; the confirm sends it again. */
export const allowlistChangeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("add"),
      chain: payeeChainSchema,
      address: payeeAddressSchema,
      label: z
        .string()
        .trim()
        .min(1, "Give the address a name.")
        .max(
          WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH,
          `Keep the name to ${WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH} characters or fewer.`,
        ),
    })
    .superRefine((change, context) => {
      const problem = payeeChainAddressProblem(change.chain, change.address);
      if (problem !== null) {
        context.addIssue({
          code: "custom",
          path: ["address"],
          message: problem,
        });
      }
    }),
  z.object({ action: z.literal("remove"), addressId: z.uuid() }),
]);

export type AllowlistChange = z.infer<typeof allowlistChangeSchema>;

const usdcBaseUnits = z
  .string({ error: "Enter an amount." })
  .regex(/^\d{1,15}$/, "Enter an amount in USDC.");

/**
 * `POST /organizations/:id/withdrawals`. `requestId` is new for each
 * withdrawal the admin starts; sending it again returns the same one.
 */
export const createWithdrawalRequestSchema = z.object({
  requestId: z.uuid(),
  addressId: z.uuid("Choose an address from the allowlist."),
  /** USDC base units (6 decimals). */
  amountUsdc: usdcBaseUnits,
});

export type CreateWithdrawalRequest = z.infer<
  typeof createWithdrawalRequestSchema
>;

export const withdrawalSchema = z.object({
  id: z.uuid(),
  /** The payee chain the withdrawal is paid on. */
  chain: payeeChainSchema,
  address: z.string(),
  label: z.string(),
  /** Exactly what leaves the wallet; Expendi pays the gas. */
  amountUsdc: z.string().regex(/^\d+$/),
  status: payoutStatusSchema,
  /**
   * The transaction that paid it: the company's own send (on NEAR) or, when
   * the company has none, the payee chain's delivery. Null until there is
   * one. Case-sensitive: show it exactly as given.
   */
  txHash: z.string().nullable(),
  /**
   * The chain `txHash` is on, so it can be labelled and linked correctly;
   * absent while `txHash` is null.
   */
  txChain: payeeChainSchema.nullable().optional(),
  failureReason: z.string().nullable(),
});

export type Withdrawal = z.infer<typeof withdrawalSchema>;

/** The passkey challenge for exactly this withdrawal, with what it pays. */
export const withdrawalChallengeSchema = approvalChallengeSchema.extend({
  withdrawal: withdrawalSchema,
});

export type WithdrawalChallenge = z.infer<typeof withdrawalChallengeSchema>;

/** `POST /organizations/:id/withdrawals/:challengeId/confirm`. */
export const confirmWithdrawalRequestSchema = z.object({
  response: passkeyAssertionSchema,
});
