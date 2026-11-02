import type {
  AddPayrollOneOffRequest,
  AdjustPayrollPaymentRequest,
  PayrollPersonPreview,
  PayrollRun,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import {
  PAYROLL_MARGIN_MAX_PCT,
  payrollRunDetailSchema,
  payrollRunPaymentSchema,
} from "@expendi-business/shared";

import type { PreviewRow } from "~/features/bills/bill-payment";
import type { ApiClient } from "~/lib/api";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { formatKesCents, formatUsdc } from "~/lib/money";

/**
 * A payroll run's draft changes and Approve & pay all (spec §6.21), as the
 * app runs them (`apps/mobile/src/features/payroll/`): the requests, each
 * person's payment, the run's cap, and how far the run has got.
 */

const runPath = (organizationId: string, runId: string) =>
  `/organizations/${organizationId}/payroll-runs/${runId}` as const;

export type DraftChange =
  | {
      readonly action: "adjust";
      readonly billId: string;
      readonly request: AdjustPayrollPaymentRequest;
    }
  | {
      readonly action: "leave_out";
      readonly billId: string;
      readonly reason: string;
    }
  | { readonly action: "one_off"; readonly request: AddPayrollOneOffRequest };

/** Changes a draft run for this run only; each change needs a reason. */
export function changeDraftRun(
  api: ApiClient,
  organizationId: string,
  runId: string,
  change: DraftChange,
): Promise<PayrollRunDetail> {
  const path = runPath(organizationId, runId);
  switch (change.action) {
    case "adjust":
      return api.patch(
        `${path}/payments/${change.billId}`,
        change.request,
        payrollRunDetailSchema,
      );
    case "leave_out":
      return api.post(
        `${path}/payments/${change.billId}/leave-out`,
        { reason: change.reason },
        payrollRunDetailSchema,
      );
    case "one_off":
      return api.post(
        `${path}/one-offs`,
        change.request,
        payrollRunDetailSchema,
      );
  }
}

export interface PayrollPaymentRequest {
  readonly runId: string;
  /** One person whose payment failed; null pays the whole draft run. */
  readonly retryBillId: string | null;
  /** Only after the admin confirmed the 24-hour warning (spec §6.19). */
  readonly secondConfirmation: boolean;
}

/** Every payout of the run (or one person's retry) and one challenge for them. */
export function preparePayrollPayment(
  api: ApiClient,
  organizationId: string,
  { runId, retryBillId, secondConfirmation }: PayrollPaymentRequest,
): Promise<PayrollRunPayment> {
  const path = runPath(organizationId, runId);
  return api.post(
    retryBillId === null
      ? `${path}/payment`
      : `${path}/payments/${retryBillId}/retry`,
    { secondConfirmation },
    payrollRunPaymentSchema,
  );
}

export function confirmPayrollPayment(
  api: ApiClient,
  organizationId: string,
  runId: string,
  challengeId: string,
  response: PasskeyAssertion,
): Promise<PayrollRunDetail> {
  return api.post(
    `${runPath(organizationId, runId)}/payment/${challengeId}/confirm`,
    { response },
    payrollRunDetailSchema,
  );
}

/** One person's payment, as the admin confirms it. */
export function personRows(person: PayrollPersonPreview): PreviewRow[] {
  const rounded = person.amountKes !== person.receivesKes;
  return [
    {
      label: "They receive",
      value: `KES ${formatKesCents(person.receivesKes)}`,
    },
    ...(rounded
      ? [
          {
            label: "Pay",
            value: `KES ${formatKesCents(person.amountKes)}, rounded up to a whole shilling`,
          },
        ]
      : []),
    { label: "Paid to", value: person.paidTo.label },
    ...(person.orders > 1
      ? [
          {
            label: "Sent as",
            value: `${String(person.orders)} payments: one Paycrest payment tops out around KES 386,000`,
          },
        ]
      : []),
    {
      label: "Total, at most",
      value: `${formatUsdc(person.maxDebitUsdc)} USDC`,
    },
  ];
}

/** The run's total and cap, as the admin confirms them (spec §7.4). */
export function capRows(payment: PayrollRunPayment): PreviewRow[] {
  return [
    {
      label: "Paying now",
      value: `KES ${formatKesCents(payment.totals.receivesKes)}`,
    },
    ...(payment.cap.committedKes !== "0"
      ? [
          {
            label: "Already paid in this run",
            value: `KES ${formatKesCents(payment.cap.committedKes)}`,
          },
        ]
      : []),
    { label: "Cap", value: `KES ${formatKesCents(payment.cap.capKes)}` },
    {
      label: "Paycrest fees, at most",
      value: `${formatUsdc(payment.totals.feeAllowanceUsdc)} USDC`,
    },
    {
      label: "Total from the wallet, at most",
      value: `${formatUsdc(payment.totals.maxDebitUsdc)} USDC`,
    },
  ];
}

/** e.g. "2 paid · 1 being paid · 1 failed"; null before the run is approved. */
export function progressInWords(
  run: Pick<PayrollRun, "status" | "progress">,
): string | null {
  if (run.status === "draft") return null;
  const { paid, paying, failed } = run.progress;
  return [
    `${String(paid)} paid`,
    ...(paying > 0 ? [`${String(paying)} being paid`] : []),
    ...(failed > 0 ? [`${String(failed)} failed`] : []),
  ].join(" · ");
}

/** The people whose payment failed, each retried on their own. */
export function failedPayments(
  run: PayrollRunDetail,
): PayrollRunDetail["payments"] {
  return run.payments.filter((payment) => payment.status === "payout_failed");
}

/** Whether a fresh preparation still costs what the admin reviewed. */
export function samePayrollCost(
  reviewed: PayrollRunPayment,
  fresh: PayrollRunPayment,
): boolean {
  return (
    reviewed.totals.maxDebitUsdc === fresh.totals.maxDebitUsdc &&
    reviewed.totals.receivesKes === fresh.totals.receivesKes &&
    reviewed.people.length === fresh.people.length
  );
}

/** A typed margin as a whole percentage, 0 to 100, or null. */
export function parseMarginPct(typed: string): number | null {
  const trimmed = typed.trim().replace(/%$/, "");
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const marginPct = Number(trimmed);
  return marginPct <= PAYROLL_MARGIN_MAX_PCT ? marginPct : null;
}
