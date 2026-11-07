import { z } from "zod";

import type { PayeeKind, PayeeMethod } from "./payee.js";
import {
  passkeyAssertionSchema,
  passkeyRequestOptionsSchema,
} from "./approval.js";
import { BILL_REASON_MAX_LENGTH, billStatusSchema } from "./bills.js";
import { kesAmountSchema } from "./claims.js";
import { payeeKindSchema, payeeMethodSchema } from "./payee.js";
import { RECURRING_ITEM_STATES } from "./recurring.js";

/**
 * Where a payroll run is (spec §6.21, §10): drafted 5 days before pay day
 * and changed only while `draft`; then paid through Expendi.
 */
export const PAYROLL_RUN_STATUSES = [
  "draft",
  "paying",
  "paid",
  "partly_failed",
] as const;
export const payrollRunStatusSchema = z.enum(PAYROLL_RUN_STATUSES);
export type PayrollRunStatus = z.infer<typeof payrollRunStatusSchema>;

/** A run is drafted this many Nairobi days before its pay day (spec §6.21). */
export const PAYROLL_DRAFT_LEAD_DAYS = 5;

/** Who can be on payroll: an employee, or personnel without an app login. */
export const SALARY_PAYEE_KINDS = [
  "employee",
  "personnel",
] as const satisfies readonly PayeeKind[];

/** Salaries go to a confirmed M-Pesa number or a bank account (spec §6.21). */
export const SALARY_PAYEE_METHODS = [
  "mpesa_phone",
  "bank",
] as const satisfies readonly PayeeMethod[];

export const SALARIES_LIST_MAX_SIZE = 500;
export const PAYROLL_RUNS_LIST_MAX_SIZE = 120;

const isoDate = (missing: string) => z.iso.date({ error: missing });

const kesCents = z.string().regex(/^\d+$/);

const payDaySchema = z
  .int({ error: "Pick the day of the month they’re paid, 1 to 31." })
  .min(1, "Pick the day of the month they’re paid, 1 to 31.")
  .max(31, "Pick the day of the month they’re paid, 1 to 31.");

function reasonSchema(missing: string) {
  return z
    .string({ error: missing })
    .trim()
    .min(1, missing)
    .max(
      BILL_REASON_MAX_LENGTH,
      `Keep the reason to ${BILL_REASON_MAX_LENGTH} characters or fewer.`,
    );
}

/**
 * A salary (spec §6.21): monthly net pay in KES, paid on `payDay`, or the
 * month's last day when it's shorter. The first pay date is the first pay
 * day on or after `startsOn`, today when left out.
 */
export const createSalaryRequestSchema = z.object({
  payeeId: z.uuid({ error: "Pick who the salary is for." }),
  amountKes: kesAmountSchema,
  payDay: payDaySchema,
  startsOn: isoDate("Enter the start date as YYYY-MM-DD.").optional(),
  categoryId: z.uuid({ error: "Pick a category." }),
});

export type CreateSalaryRequest = z.input<typeof createSalaryRequestSchema>;
export type CreateSalaryFields = z.output<typeof createSalaryRequestSchema>;

/**
 * Changes that need no passkey. A new pay day applies from the next pay
 * date not yet drafted. Net pay changes through `…/amount`.
 */
export const updateSalaryRequestSchema = z
  .object({
    payDay: payDaySchema.optional(),
    categoryId: z.uuid({ error: "Pick a category." }).optional(),
  })
  .refine(
    (update) => update.payDay !== undefined || update.categoryId !== undefined,
    "Change the pay day or the category.",
  );

export type UpdateSalaryRequest = z.input<typeof updateSalaryRequestSchema>;
export type UpdateSalaryFields = z.output<typeof updateSalaryRequestSchema>;

/** `POST …/salaries/:id/amount`: asks for the passkey to change net pay. */
export const changeSalaryAmountRequestSchema = z.object({
  amountKes: kesAmountSchema,
});

export type ChangeSalaryAmountRequest = z.input<
  typeof changeSalaryAmountRequestSchema
>;

/** What the admin's passkey confirms: this salary's new net pay, in KES cents. */
export const salaryAmountChangeSchema = z.object({
  salaryId: z.uuid(),
  amountKesCents: kesCents,
});

export type SalaryAmountChange = z.infer<typeof salaryAmountChangeSchema>;

export const salaryAmountChallengeSchema = z.object({
  status: z.literal("confirmation_required"),
  challengeId: z.uuid(),
  options: passkeyRequestOptionsSchema,
  /** Send this back unchanged with the passkey's response. */
  change: salaryAmountChangeSchema,
});

export type SalaryAmountChallenge = z.infer<typeof salaryAmountChallengeSchema>;

/** `POST …/salaries/amount-changes/:challengeId/confirm`. */
export const confirmSalaryAmountChangeRequestSchema = z.object({
  change: salaryAmountChangeSchema,
  response: passkeyAssertionSchema,
});

export type ConfirmSalaryAmountChangeRequest = z.input<
  typeof confirmSalaryAmountChangeRequestSchema
>;

const payrollPayeeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: payeeKindSchema,
  /** Null until the payee's payment details are added. */
  method: payeeMethodSchema.nullable(),
  archived: z.boolean(),
  /** Employees only: whether they've confirmed an M-Pesa number. */
  payoutPhoneConfirmed: z.boolean().nullable(),
  /**
   * The last 4 digits of the bank account or M-Pesa number they're paid
   * to, e.g. "0915"; null when there are no details, for Till and Paybill
   * payments, and for an employee's own M-Pesa number, which is never shown.
   */
  accountEnding: z.string().nullable(),
});

export const salarySchema = z.object({
  id: z.uuid(),
  /** `ended` is final; a `paused` salary isn't drafted into runs. */
  state: z.enum(RECURRING_ITEM_STATES),
  payee: payrollPayeeSchema,
  category: z.object({ id: z.uuid(), name: z.string() }),
  /** Monthly net pay, KES cents as a decimal string. */
  amountKes: kesCents,
  payDay: z.int(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  /** The next pay date not yet in a payroll run; null once ended. */
  nextPayDate: z.iso.date().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Salary = z.infer<typeof salarySchema>;

export const salariesResponseSchema = z.array(salarySchema);

/** Changes one person's pay in a draft run, for this run only. */
export const adjustPayrollPaymentRequestSchema = z.object({
  amountKes: kesAmountSchema,
  reason: reasonSchema("Say why their pay changes this time."),
});

export type AdjustPayrollPaymentRequest = z.input<
  typeof adjustPayrollPaymentRequestSchema
>;

export const leaveOutOfPayrollRequestSchema = z.object({
  reason: reasonSchema("Say why they’re left out this time."),
});

export type LeaveOutOfPayrollRequest = z.input<
  typeof leaveOutOfPayrollRequestSchema
>;

/**
 * An extra payment in a draft run, e.g. a bonus. The category defaults to
 * the person's salary.
 */
export const addPayrollOneOffRequestSchema = z.object({
  payeeId: z.uuid({ error: "Pick who it’s for." }),
  amountKes: kesAmountSchema,
  reason: reasonSchema("Say what the payment is for."),
  categoryId: z.uuid({ error: "Pick a category." }).optional(),
});

export type AddPayrollOneOffRequest = z.input<
  typeof addPayrollOneOffRequestSchema
>;

export const PAYROLL_PAYMENT_KINDS = ["salary", "one_off"] as const;
export type PayrollPaymentKind = (typeof PAYROLL_PAYMENT_KINDS)[number];

export const payrollPaymentSchema = z.object({
  /** Each payment is a bill in the run. */
  billId: z.uuid(),
  kind: z.enum(PAYROLL_PAYMENT_KINDS),
  /** The salary it was drafted from; null for a one-off. */
  salaryId: z.uuid().nullable(),
  payee: payrollPayeeSchema,
  category: z.object({ id: z.uuid(), name: z.string() }),
  amountKes: kesCents,
  status: billStatusSchema,
  /** Why the amount differs from their salary this time. */
  adjustmentReason: z.string().nullable(),
  /** A one-off's reason. */
  note: z.string().nullable(),
  leftOut: z.object({ reason: z.string(), at: z.iso.datetime() }).nullable(),
  paidOn: z.iso.date().nullable(),
});

export type PayrollPayment = z.infer<typeof payrollPaymentSchema>;

export const payrollRunSchema = z.object({
  id: z.uuid(),
  payDate: z.iso.date(),
  status: payrollRunStatusSchema,
  /** What the run pays: everyone not left out, with adjustments and one-offs. */
  totalKes: kesCents,
  /** The net pay of the salaries drafted into the run. */
  salariesKes: kesCents,
  /** The most the run can pay: the salaries plus the company's margin. */
  capKes: kesCents,
  /** Payments not left out. */
  people: z.int().nonnegative(),
  leftOut: z.int().nonnegative(),
  /** Payments not left out whose amount was changed for this run. */
  adjusted: z.int().nonnegative(),
  /** One-off payments not left out. */
  oneOffs: z.int().nonnegative(),
  /** How many payments are paid, being paid and failed (spec §6.21). */
  progress: z.object({
    paid: z.int().nonnegative(),
    paying: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  createdAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
});

export type PayrollRun = z.infer<typeof payrollRunSchema>;

export const payrollRunsResponseSchema = z.array(payrollRunSchema);

export const payrollRunDetailSchema = payrollRunSchema.extend({
  payments: z.array(payrollPaymentSchema),
});

export type PayrollRunDetail = z.infer<typeof payrollRunDetailSchema>;

/** A person sees a salary payment once its run is approved (spec §4). */
export const MY_SALARY_PAYMENT_STATUSES = [
  "paying",
  "paid",
  "payout_failed",
] as const;

export const mySalaryPaymentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(PAYROLL_PAYMENT_KINDS),
  payDate: z.iso.date(),
  amountKes: kesCents,
  status: z.enum(MY_SALARY_PAYMENT_STATUSES),
  paidOn: z.iso.date().nullable(),
});

export type MySalaryPayment = z.infer<typeof mySalaryPaymentSchema>;

export const mySalaryPaymentsResponseSchema = z.array(mySalaryPaymentSchema);
