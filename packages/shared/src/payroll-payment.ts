import { z } from "zod";

import {
  approvalChallengeSchema,
  passkeyAssertionSchema,
  passkeyRequestOptionsSchema,
} from "./approval.js";
import { paymentDestinationSchema } from "./bill-payment.js";
import { claimPaymentWalletSchema } from "./claim-approval.js";

/**
 * Approve & pay all on a payroll run, and retrying one person (spec
 * §6.21); the payroll cap's margin (spec §7.4). Money is a decimal string
 * of integer units: KES in cents, USDC in base units (6 decimals).
 */

const units = z.string().regex(/^\d+$/);

/** One person's payment, as the admin confirms it. */
export const payrollPersonPreviewSchema = z.object({
  billId: z.uuid(),
  payeeName: z.string(),
  paidTo: paymentDestinationSchema,
  /** Their pay, or for a retry what's left after the parts already paid. */
  amountKes: units,
  /** What reaches them: each order rounded up to a whole shilling. */
  receivesKes: units,
  /** More than one when the salary is above the largest single cash-out. */
  orders: z.int().positive(),
  payoutIds: z.array(z.uuid()),
  rate: z.string(),
  usdc: units,
  feeAllowanceUsdc: units,
  maxDebitUsdc: units,
});

export type PayrollPersonPreview = z.infer<typeof payrollPersonPreviewSchema>;

/** The passkey challenge for the run's payouts, with what they cost. */
export const payrollRunPaymentSchema = approvalChallengeSchema.extend({
  runId: z.uuid(),
  people: z.array(payrollPersonPreviewSchema),
  totals: z.object({
    receivesKes: units,
    usdc: units,
    feeAllowanceUsdc: units,
    maxDebitUsdc: units,
  }),
  /** The run's cap (spec §7.4); approving checks it again, under lock. */
  cap: z.object({
    capKes: units,
    /** Already paid or being paid in this run. */
    committedKes: units,
    withinCap: z.boolean(),
  }),
  wallet: claimPaymentWalletSchema,
});

export type PayrollRunPayment = z.infer<typeof payrollRunPaymentSchema>;

/** `POST …/payroll-runs/:runId/payment/:challengeId/confirm`. */
export const confirmPayrollRunPaymentRequestSchema = z.object({
  response: passkeyAssertionSchema,
});

/** The margin above active salaries a run may pay (spec §7.4), 20% by default. */
export const PAYROLL_MARGIN_MAX_PCT = 100;

const marginPct = z
  .int({ error: "Enter the margin as a whole percentage, 0 to 100." })
  .min(0, "Enter the margin as a whole percentage, 0 to 100.")
  .max(
    PAYROLL_MARGIN_MAX_PCT,
    "Enter the margin as a whole percentage, 0 to 100.",
  );

/** `POST /organizations/:id/settings/payroll-margin`: asks for the passkey. */
export const changePayrollMarginRequestSchema = z.object({ marginPct });

export type ChangePayrollMarginRequest = z.input<
  typeof changePayrollMarginRequestSchema
>;

/** What the admin's passkey confirms: the company's new margin. */
export const payrollMarginChangeSchema = z.object({ marginPct });

export type PayrollMarginChange = z.infer<typeof payrollMarginChangeSchema>;

export const payrollMarginChallengeSchema = z.object({
  status: z.literal("confirmation_required"),
  challengeId: z.uuid(),
  options: passkeyRequestOptionsSchema,
  /** Send this back unchanged with the passkey's response. */
  change: payrollMarginChangeSchema,
});

export type PayrollMarginChallenge = z.infer<
  typeof payrollMarginChallengeSchema
>;

/** `POST …/settings/payroll-margin/:challengeId/confirm`. */
export const confirmPayrollMarginRequestSchema = z.object({
  change: payrollMarginChangeSchema,
  response: passkeyAssertionSchema,
});

export type ConfirmPayrollMarginRequest = z.input<
  typeof confirmPayrollMarginRequestSchema
>;

export const payrollMarginSchema = z.object({ marginPct: z.int() });

export type PayrollMargin = z.infer<typeof payrollMarginSchema>;
