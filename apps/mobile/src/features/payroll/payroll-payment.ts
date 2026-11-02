import type {
  PayrollPersonPreview,
  PayrollRun,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import { PAYROLL_MARGIN_MAX_PCT } from "@expendi-business/shared";

import type { PreviewRow } from "../claims/payment";
import { formatKesCents, formatUsdc } from "../../lib/money";

/**
 * Approve & pay all's display logic (spec §6.21): each person's payment,
 * the run's cap, and how far the run has got.
 */

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
            value: `${person.orders} payments: one Paycrest payment tops out around KES 386,000`,
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
    `${paid} paid`,
    ...(paying > 0 ? [`${paying} being paid`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
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
