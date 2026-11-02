import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import { billCurrencySchema, billStatusSchema } from "./bills.js";
import { claimPaymentWalletSchema } from "./claim-approval.js";
import { payoutStatusSchema } from "./wallet-history.js";

/**
 * Paying bills through Expendi (spec §6.20): **Pay** on one bill or **Pay
 * all** on several, one passkey for them all, one payout each. Money is a
 * decimal string of integer units: KES in cents, USDC in base units (6
 * decimals).
 */

/** The most bills one Pay all covers. */
export const BILL_PAYMENT_MAX_BILLS = 20;

const units = z.string().regex(/^\d+$/);

/**
 * The admin saw the warning that a payee's details changed in the last 24
 * hours and confirmed again (spec §6.19, §7.8). Only send `true` from that
 * explicit second confirmation.
 */
const secondConfirmation = z.boolean().default(false);

/** `POST /organizations/:id/bills/payment`, for unpaid bills. */
export const payBillsRequestSchema = z.object({
  billIds: z
    .array(z.uuid("That bill wasn't found."), {
      error: "Choose a bill to pay.",
    })
    .min(1, "Choose a bill to pay.")
    .max(
      BILL_PAYMENT_MAX_BILLS,
      `Pay at most ${BILL_PAYMENT_MAX_BILLS} bills at once.`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Each bill can only be in the list once.",
    ),
  secondConfirmation,
});

export type PayBillsRequest = z.input<typeof payBillsRequestSchema>;

/** `POST …/bills/:billId/retry` and payroll's per-person retry. */
export const retryPaymentRequestSchema = z.object({ secondConfirmation });

export type RetryPaymentRequest = z.input<typeof retryPaymentRequestSchema>;

/** Where a payment goes, as the admin recognises it. */
export const paymentDestinationSchema = z.object({
  method: z.enum([
    "mpesa_phone",
    "mpesa_till",
    "mpesa_paybill",
    "bank",
    "usdc",
  ]),
  /**
   * e.g. "M-Pesa ending 5678", "Till 123456", "Paybill 888880, account
   * A-17", "Bank account ending 4321" or "0x1234…abcd".
   */
  label: z.string(),
});

export type PaymentDestination = z.infer<typeof paymentDestinationSchema>;

/** One bill's payment, as the admin confirms it (spec §6.20). */
export const billPaymentPreviewSchema = z.object({
  billId: z.uuid(),
  payoutId: z.uuid(),
  payeeName: z.string(),
  paidTo: paymentDestinationSchema,
  currency: billCurrencySchema,
  /** A KES bill's amount; null for a USD bill. */
  billedKes: units.nullable(),
  /** What reaches a KES payee: rounded up to a whole shilling. Null for USDC. */
  receivesKes: units.nullable(),
  /** Exactly what a USDC payee receives; null for KES. */
  receivesUsdc: units.nullable(),
  /** What counts towards the daily cap: the KES, or the USDC at today's rate. */
  kesEquivalent: units,
  /** Paycrest's quoted KES per USDC. */
  rate: z.string(),
  /** The USDC Paycrest converts, or the USDC sent. */
  usdc: units,
  /** The most Paycrest's fee and a rate move can add; 0 for USDC. */
  feeAllowanceUsdc: units,
  /** The most USDC that can leave the wallet for it. */
  maxDebitUsdc: units,
});

export type BillPaymentPreview = z.infer<typeof billPaymentPreviewSchema>;

export const billPaymentTotalsSchema = z.object({
  receivesKes: units,
  receivesUsdc: units,
  kesEquivalent: units,
  usdc: units,
  feeAllowanceUsdc: units,
  maxDebitUsdc: units,
});

export type BillPaymentTotals = z.infer<typeof billPaymentTotalsSchema>;

/** The passkey challenge for exactly these bills, with what they cost. */
export const billPaymentSchema = approvalChallengeSchema.extend({
  bills: z.array(billPaymentPreviewSchema),
  totals: billPaymentTotalsSchema,
  wallet: claimPaymentWalletSchema,
});

export type BillPayment = z.infer<typeof billPaymentSchema>;

/** `POST /organizations/:id/bills/payment/:challengeId/confirm`. */
export const confirmBillPaymentRequestSchema = z.object({
  response: passkeyAssertionSchema,
});

/** Where each bill and its payout stand once Pay returns. */
export const billPaymentResultSchema = z.object({
  bills: z.array(
    z.object({
      billId: z.uuid(),
      status: billStatusSchema,
      payout: z.object({
        id: z.uuid(),
        status: payoutStatusSchema,
        failureReason: z.string().nullable(),
      }),
    }),
  ),
});

export type BillPaymentResult = z.infer<typeof billPaymentResultSchema>;

/**
 * The `details` of the 409 when a payee's payment details changed in the
 * last 24 hours: ask again with `secondConfirmation` once the admin has
 * checked them (spec §6.19).
 */
export const payeeChangeHoldSchema = z.object({
  reason: z.literal("payee_details_changed"),
  payees: z.array(
    z.object({
      payeeId: z.uuid(),
      name: z.string(),
      detailsChangedAt: z.iso.datetime(),
    }),
  ),
});

export type PayeeChangeHold = z.infer<typeof payeeChangeHoldSchema>;
