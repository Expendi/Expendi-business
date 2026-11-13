import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import { expenseStatusSchema } from "./claims.js";
import { payoutStatusSchema } from "./wallet-history.js";

/**
 * Approve & pay and reject (spec §6.7, §6.8): the admin's side of a claim.
 * Money is a decimal string of integer units: KES in cents, USDC in base
 * units (6 decimals).
 */

/** The most claims one Approve & pay covers ("approve selected"). */
export const CLAIM_APPROVAL_MAX_CLAIMS = 20;

const units = z.string().regex(/^\d+$/);

/** `POST /organizations/:id/claims/approval`, for submitted claims. */
export const approveClaimsRequestSchema = z.object({
  claimIds: z
    .array(z.uuid("That claim wasn't found."), {
      error: "Choose a claim to approve.",
    })
    .min(1, "Choose a claim to approve.")
    .max(
      CLAIM_APPROVAL_MAX_CLAIMS,
      `Approve at most ${CLAIM_APPROVAL_MAX_CLAIMS} claims at once.`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Each claim can only be in the list once.",
    ),
});

export type ApproveClaimsRequest = z.infer<typeof approveClaimsRequestSchema>;

/** One claim's payment, as the admin confirms it (spec §6.7 step 2). */
export const claimPaymentPreviewSchema = z.object({
  claimId: z.uuid(),
  payoutId: z.uuid(),
  /** The name the cash-out pays. */
  claimantName: z.string(),
  /** The last four digits of the claimant's confirmed M-Pesa number. */
  phoneLast4: z.string(),
  /** What was claimed. */
  claimedKes: units,
  /** What reaches their M-Pesa: the claim rounded up to a whole shilling. */
  receivesKes: units,
  /** The cash-out's quoted KES per USDC. */
  rate: z.string(),
  /** The USDC converted into `receivesKes`. */
  usdc: units,
  /**
   * The most a cash-out fee and a rate move can add. The exact fee is
   * known only once the cash-out is under way; whatever isn't used stays in
   * the wallet.
   */
  feeAllowanceUsdc: units,
  /** The most USDC that can leave the wallet for it: `usdc` + `feeAllowanceUsdc`. */
  maxDebitUsdc: units,
});

export type ClaimPaymentPreview = z.infer<typeof claimPaymentPreviewSchema>;

export const claimPaymentTotalsSchema = z.object({
  receivesKes: units,
  usdc: units,
  feeAllowanceUsdc: units,
  maxDebitUsdc: units,
});

export type ClaimPaymentTotals = z.infer<typeof claimPaymentTotalsSchema>;

/**
 * The wallet against the total, when the payment was prepared. Approving
 * checks it again under lock. Short by `shortfallUsdc` means "Top up KES
 * `topUpKes`" (spec §6.7 step 4).
 */
export const claimPaymentWalletSchema = z.object({
  availableUsdc: units,
  shortfallUsdc: units,
  /** Whole shillings, in cents, at the quoted rate; null when the wallet covers it. */
  topUpKes: units.nullable(),
});

export type ClaimPaymentWallet = z.infer<typeof claimPaymentWalletSchema>;

/** The passkey challenge for exactly these payments, with what they cost. */
export const claimApprovalSchema = approvalChallengeSchema.extend({
  claims: z.array(claimPaymentPreviewSchema),
  totals: claimPaymentTotalsSchema,
  wallet: claimPaymentWalletSchema,
});

export type ClaimApproval = z.infer<typeof claimApprovalSchema>;

/** `POST /organizations/:id/claims/approval/:challengeId/confirm`. */
export const confirmClaimApprovalRequestSchema = z.object({
  response: passkeyAssertionSchema,
});

/** Where each claim and its payout stand once Approve & pay returns. */
export const claimPaymentResultSchema = z.object({
  claims: z.array(
    z.object({
      claimId: z.uuid(),
      status: expenseStatusSchema,
      payout: z.object({
        id: z.uuid(),
        status: payoutStatusSchema,
        failureReason: z.string().nullable(),
      }),
    }),
  ),
});

export type ClaimPaymentResult = z.infer<typeof claimPaymentResultSchema>;

/** The `details` of the 409 when the wallet is too short to approve. */
export const topUpNeededSchema = z.object({
  shortfallUsdc: units,
  /** Whole shillings, in cents, at the quoted rate. */
  topUpKes: units,
});

export type TopUpNeeded = z.infer<typeof topUpNeededSchema>;

export const REJECTION_REASON_MIN_LENGTH = 5;
export const REJECTION_REASON_MAX_LENGTH = 500;

/** `POST /organizations/:id/claims/:claimId/reject`; the employee sees the reason. */
export const rejectClaimRequestSchema = z.object({
  reason: z
    .string({ error: "Say why it's rejected." })
    .trim()
    .min(
      REJECTION_REASON_MIN_LENGTH,
      "Say why in a few words, so they know what to fix.",
    )
    .max(
      REJECTION_REASON_MAX_LENGTH,
      `Keep the reason to ${REJECTION_REASON_MAX_LENGTH} characters or fewer.`,
    ),
});

export type RejectClaimRequest = z.infer<typeof rejectClaimRequestSchema>;
