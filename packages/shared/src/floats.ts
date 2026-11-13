import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import { paymentReceiptsSchema } from "./cash-out-receipt.js";
import { claimPaymentWalletSchema } from "./claim-approval.js";
import {
  etimsStatusSchema,
  expenseStatusSchema,
  expenseWarningSchema,
  kesAmountSchema,
  MAX_RECEIPTS_PER_CLAIM,
  submitClaimRequestSchema,
} from "./claims.js";
import {
  NO_RECEIPT_REASON_MAX_LENGTH,
  NO_RECEIPT_REASON_MIN_LENGTH,
} from "./company-spending.js";
import { payoutStatusSchema } from "./wallet-history.js";

/**
 * Petty cash floats (spec §6.22): money paid to a person's M-Pesa ahead of
 * spending. The holder records what they spend from it; an admin issues,
 * tops up, records returns and closes it. Money is a decimal string of
 * integer units: KES in cents, USDC in base units (6 decimals).
 */

const units = z.string().regex(/^\d+$/);

export const FLOAT_STATUSES = ["open", "closed"] as const;
export const floatStatusSchema = z.enum(FLOAT_STATUSES);
export type FloatStatus = z.infer<typeof floatStatusSchema>;

/**
 * Issues and top-ups are payouts to the holder's confirmed M-Pesa. A return
 * is cash handed back outside the app. A write-off is what was still with
 * the holder when an admin closed the float without getting it back.
 */
export const FLOAT_MOVEMENT_TYPES = [
  "issue",
  "top_up",
  "return",
  "write_off",
] as const;
export const floatMovementTypeSchema = z.enum(FLOAT_MOVEMENT_TYPES);
export type FloatMovementType = z.infer<typeof floatMovementTypeSchema>;

/**
 * An issue or top-up is `pending` from the moment its payout is prepared
 * until that payout is `paid` or `failed`; only `paid` counts toward the
 * balance. Returns and write-offs are `recorded` as they're entered.
 */
export const FLOAT_MOVEMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "recorded",
] as const;
export const floatMovementStatusSchema = z.enum(FLOAT_MOVEMENT_STATUSES);
export type FloatMovementStatus = z.infer<typeof floatMovementStatusSchema>;

/**
 * Where a movement stands, as people read it: a pending one is either
 * waiting for an admin's passkey or approved and on its way.
 */
export const FLOAT_MOVEMENT_PHASES = [
  "awaiting_approval",
  "on_its_way",
  "paid",
  "failed",
  "recorded",
] as const;
export const floatMovementPhaseSchema = z.enum(FLOAT_MOVEMENT_PHASES);
export type FloatMovementPhase = z.infer<typeof floatMovementPhaseSchema>;

/**
 * How a purchase of `amountKes` splits when `leftKes` is on the float:
 * whatever fits is float spending, and only the extra becomes a claim
 * (spec §6.22). The app shows this before submitting; the API applies it
 * under the float's lock.
 */
export function splitFloatPurchase(
  amountKes: bigint,
  leftKes: bigint,
): { readonly fromFloatKes: bigint; readonly claimedKes: bigint } {
  const available = leftKes > 0n ? leftKes : 0n;
  const fromFloatKes = amountKes < available ? amountKes : available;
  return { fromFloatKes, claimedKes: amountKes - fromFloatKes };
}

const pickSomeone = "Pick who holds the float.";

/** `POST /organizations/:id/floats`: open a float and prepare its first payment. */
export const issueFloatRequestSchema = z.object({
  membershipId: z.uuid({ error: pickSomeone }),
  amountKes: kesAmountSchema,
});

export type IssueFloatRequest = z.input<typeof issueFloatRequestSchema>;

/** `POST …/floats/:floatId/top-ups`. */
export const topUpFloatRequestSchema = z.object({
  amountKes: kesAmountSchema,
});

export type TopUpFloatRequest = z.input<typeof topUpFloatRequestSchema>;

export const FLOAT_NOTE_MAX_LENGTH = 300;

/** Blank means none. */
const optionalNote = z
  .string()
  .trim()
  .max(
    FLOAT_NOTE_MAX_LENGTH,
    `Keep the note to ${FLOAT_NOTE_MAX_LENGTH} characters or fewer.`,
  )
  .transform((note) => (note.length === 0 ? null : note))
  .nullish();

/** `POST …/floats/:floatId/returns`: cash the holder handed back outside the app. */
export const recordFloatReturnRequestSchema = z.object({
  amountKes: kesAmountSchema,
  note: optionalNote,
});

export type RecordFloatReturnRequest = z.input<
  typeof recordFloatReturnRequestSchema
>;
export type RecordFloatReturnFields = z.output<
  typeof recordFloatReturnRequestSchema
>;

export const WRITE_OFF_REASON_MIN_LENGTH = 8;

const sayWhyWriteOff = "Say why what's left isn't coming back, in a few words.";

/**
 * `POST …/floats/:floatId/close`. A float closes once nothing is left on
 * it. With money still on it, `writeOffReason` writes that off and closes
 * it anyway; without one, closing is refused.
 */
export const closeFloatRequestSchema = z.object({
  writeOffReason: z
    .string({ error: sayWhyWriteOff })
    .trim()
    .min(WRITE_OFF_REASON_MIN_LENGTH, sayWhyWriteOff)
    .max(
      FLOAT_NOTE_MAX_LENGTH,
      `Keep the reason to ${FLOAT_NOTE_MAX_LENGTH} characters or fewer.`,
    )
    .nullish(),
});

export type CloseFloatRequest = z.input<typeof closeFloatRequestSchema>;

const sayWhyNoReceipt = "Say why there’s no receipt, in a few words.";

/**
 * "Paid from petty cash" (spec §6.22): the claim capture flow. With no
 * receipt, `noReceiptReason` is required and the spending is flagged "no
 * receipt" for the admins. Spending over what's left becomes a claim for
 * the extra, which always needs a receipt.
 */
export const recordFloatSpendingRequestSchema = submitClaimRequestSchema
  .pick({
    merchant: true,
    amountKes: true,
    spentOn: true,
    categoryId: true,
    description: true,
    mpesaCode: true,
    etimsInvoiceNumber: true,
    etimsSupplierPin: true,
    etimsQrPayload: true,
  })
  .extend({
    receiptFileIds: z
      .array(z.uuid({ error: "That receipt isn't available." }))
      .max(
        MAX_RECEIPTS_PER_CLAIM,
        `Add at most ${MAX_RECEIPTS_PER_CLAIM} receipts.`,
      )
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "The same receipt is added twice.",
      )
      .default([]),
    noReceiptReason: z
      .string({ error: sayWhyNoReceipt })
      .trim()
      .min(NO_RECEIPT_REASON_MIN_LENGTH, sayWhyNoReceipt)
      .max(
        NO_RECEIPT_REASON_MAX_LENGTH,
        `Keep the reason to ${NO_RECEIPT_REASON_MAX_LENGTH} characters or fewer.`,
      )
      .nullish(),
  });

export type RecordFloatSpendingRequest = z.input<
  typeof recordFloatSpendingRequestSchema
>;
export type RecordFloatSpendingFields = z.output<
  typeof recordFloatSpendingRequestSchema
>;

/** `GET …/floats`: admins get every float, others their own; `mine=true` narrows an admin's list to theirs. */
export const listFloatsQuerySchema = z.object({
  status: floatStatusSchema.optional(),
  mine: z
    .enum(["true", "false"], { error: "mine is true or false." })
    .transform((value) => value === "true")
    .optional(),
});

export type ListFloatsQuery = z.input<typeof listFloatsQuerySchema>;

/**
 * A float and its balance, worked out from its movements and spending
 * whenever it's read, never stored.
 */
export const floatSummarySchema = z.object({
  id: z.uuid(),
  status: floatStatusSchema,
  holder: z.object({
    membershipId: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  /** The caller holds it. */
  yours: z.boolean(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Issued and topped up, counted once each payment is paid. */
  issuedKes: units,
  /** Recorded spending from it; what went over it is a claim instead. */
  spentKes: units,
  returnedKes: units,
  writtenOffKes: units,
  /** issued − spent − returned − written off. */
  leftKes: units,
  /** Approved issues and top-ups that haven't reached the holder yet. */
  onTheWayKes: units,
  /** Issues and top-ups waiting for an admin's passkey. */
  awaitingApprovalKes: units,
  spendingCount: z.number().int().nonnegative(),
  /** Spending with no receipt of its own or on its overspend claim. */
  noReceiptCount: z.number().int().nonnegative(),
});

export type FloatSummary = z.infer<typeof floatSummarySchema>;

export const floatMovementSchema = z.object({
  id: z.uuid(),
  type: floatMovementTypeSchema,
  status: floatMovementStatusSchema,
  phase: floatMovementPhaseSchema,
  amountKes: units,
  /** A return's note, or why the rest was written off. */
  note: z.string().nullable(),
  /** The admin who entered it. */
  recordedBy: z.string(),
  createdAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  /** The M-Pesa receipt of an issue or top-up, once paid. */
  paymentReceipts: paymentReceiptsSchema,
  /** The latest payment of an issue or top-up, for admins only. */
  payout: z
    .object({
      id: z.uuid(),
      status: payoutStatusSchema,
      failureReason: z.string().nullable(),
    })
    .nullable(),
});

export type FloatMovement = z.infer<typeof floatMovementSchema>;

/** The claim for a purchase's extra over the float (spec §6.22). */
export const overspendClaimSchema = z.object({
  id: z.uuid(),
  amountKes: units,
  status: expenseStatusSchema,
});

export type OverspendClaim = z.infer<typeof overspendClaimSchema>;

/**
 * Spending recorded against a float. When the purchase went over the float,
 * its receipts, M-Pesa code and eTIMS invoice number are on the overspend
 * claim, which the admin approves.
 */
export const floatSpendingSchema = z.object({
  id: z.uuid(),
  merchant: z.string(),
  amountKes: units,
  spentOn: z.iso.date(),
  description: z.string().nullable(),
  category: z.object({ id: z.uuid(), name: z.string() }),
  etimsStatus: etimsStatusSchema,
  noReceipt: z.boolean(),
  noReceiptReason: z.string().nullable(),
  receiptCount: z.number().int().nonnegative(),
  overspendClaim: overspendClaimSchema.nullable(),
  /** For admins only; always empty for anyone else. */
  warnings: z.array(expenseWarningSchema),
  createdAt: z.iso.datetime(),
});

export type FloatSpending = z.infer<typeof floatSpendingSchema>;

export const floatDetailSchema = floatSummarySchema.extend({
  /** Newest first. */
  movements: z.array(floatMovementSchema),
  /** Latest date first. */
  spending: z.array(floatSpendingSchema),
  /** Every claim for spending over this float, including purchases made when nothing was left. */
  overspendClaims: z.array(
    overspendClaimSchema.extend({
      merchant: z.string(),
      spentOn: z.iso.date(),
    }),
  ),
});

export type FloatDetail = z.infer<typeof floatDetailSchema>;

/** Open floats first, then the most recently opened. */
export const floatsResponseSchema = z.object({
  floats: z.array(floatSummarySchema),
});

export type FloatsResponse = z.infer<typeof floatsResponseSchema>;

/** What a purchase "paid from petty cash" became. */
export const floatSpendingResultSchema = z.object({
  float: floatSummarySchema,
  /** Null when nothing was left on the float, so the whole purchase is a claim. */
  spending: floatSpendingSchema.nullable(),
  /** The extra over the float, submitted for approval like any claim. */
  overspendClaim: overspendClaimSchema.nullable(),
});

export type FloatSpendingResult = z.infer<typeof floatSpendingResultSchema>;

/** An issue or top-up's payment, as the admin confirms it (spec §6.7 step 2). */
export const floatPaymentPreviewSchema = z.object({
  movementId: z.uuid(),
  payoutId: z.uuid(),
  /** The name the cash-out pays. */
  holderName: z.string(),
  /** The last four digits of the holder's confirmed M-Pesa number. */
  phoneLast4: z.string(),
  /** What the admin asked to send. */
  requestedKes: units,
  /** What reaches their M-Pesa: rounded up to a whole shilling. */
  receivesKes: units,
  rate: z.string(),
  usdc: units,
  feeAllowanceUsdc: units,
  maxDebitUsdc: units,
});

export type FloatPaymentPreview = z.infer<typeof floatPaymentPreviewSchema>;

/** The passkey challenge for one issue or top-up, with what it costs. */
export const floatApprovalSchema = approvalChallengeSchema.extend({
  float: floatSummarySchema,
  movement: floatMovementSchema,
  payment: floatPaymentPreviewSchema,
  wallet: claimPaymentWalletSchema,
});

export type FloatApproval = z.infer<typeof floatApprovalSchema>;

/** `POST …/floats/approval/:challengeId/confirm`. */
export const confirmFloatApprovalRequestSchema = z.object({
  response: passkeyAssertionSchema,
});

/** Where the float and the paid movement stand once Approve & pay returns. */
export const floatPaymentResultSchema = z.object({
  float: floatSummarySchema,
  movement: floatMovementSchema,
});

export type FloatPaymentResult = z.infer<typeof floatPaymentResultSchema>;
