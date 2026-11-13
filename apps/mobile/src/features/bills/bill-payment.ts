import type {
  Bill,
  BillPayment,
  BillPaymentPreview,
  BillPaymentResult,
  BillStatus,
  PayeeChangeHold,
} from "@expendi-business/shared";
import {
  BILL_PAYMENT_MAX_BILLS,
  currencyForPayeeMethod,
  payeeChangeHoldSchema,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { PreviewRow } from "../claims/payment";
import { ApiError } from "../../lib/api";
import { formatKesCents, formatUsdc } from "../../lib/money";
import { storedAmount } from "./bill-amount";
import { automaticCard } from "./bill-card";

/**
 * Pay and Pay all's display logic (spec §6.20): which bills can be paid,
 * the cost preview's rows, the 24-hour hold's warning (spec §6.19) and
 * what a payment's outcome means for the admin.
 */

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

/**
 * Whether the app offers to pay the bill through Expendi: unpaid, not a
 * salary (those go with their payroll run), not one a company-held card
 * pays, a payee Expendi can pay, and its amount entered in the payee's
 * currency. The API checks it all again.
 */
export function isPayable(bill: Bill): boolean {
  const { method } = bill.payee;
  return (
    isUnpaid(bill.status) &&
    bill.payrollRunId === null &&
    automaticCard(bill) === null &&
    method !== null &&
    method !== "outside" &&
    !bill.payee.archived &&
    currencyForPayeeMethod(method) === bill.currency &&
    storedAmount(bill) !== null
  );
}

/** `billIds` as the pay screen takes them in its URL. */
export const joinBillIds = (billIds: readonly string[]): string =>
  billIds.join(",");

export const splitBillIds = (joined: string | undefined): string[] =>
  (joined ?? "").split(",").filter((id) => id.length > 0);

/** One bill's payment, as the admin confirms it. */
export function billPreviewRows(preview: BillPaymentPreview): PreviewRow[] {
  const receives =
    preview.receivesUsdc !== null
      ? `${formatUsdc(preview.receivesUsdc)} USDC, exactly`
      : `KES ${formatKesCents(preview.receivesKes ?? "0")}`;
  const rounded =
    preview.billedKes !== null && preview.billedKes !== preview.receivesKes;
  return [
    { label: "They receive", value: receives },
    ...(rounded && preview.billedKes !== null
      ? [
          {
            label: "Billed",
            value: `KES ${formatKesCents(preview.billedKes)}, rounded up to a whole shilling`,
          },
        ]
      : []),
    { label: "Paid to", value: preview.paidTo.label },
    ...(preview.currency === "usd"
      ? [
          {
            label: "Counts towards today’s cap as",
            value: `KES ${formatKesCents(preview.kesEquivalent)}`,
          },
        ]
      : [{ label: "USDC", value: `${formatUsdc(preview.usdc)} USDC` }]),
    {
      label: "Cash-out fee, at most",
      value: `${formatUsdc(preview.feeAllowanceUsdc)} USDC`,
    },
    {
      label: "Total, at most",
      value: `${formatUsdc(preview.maxDebitUsdc)} USDC`,
    },
  ];
}

/** The batch's total, as the admin confirms it. */
export function billTotalRows(payment: BillPayment): PreviewRow[] {
  const { totals } = payment;
  return [
    ...(totals.receivesKes !== "0"
      ? [
          {
            label: "Paid in KES",
            value: `KES ${formatKesCents(totals.receivesKes)}`,
          },
        ]
      : []),
    ...(totals.receivesUsdc !== "0"
      ? [
          {
            label: "Paid in USDC",
            value: `${formatUsdc(totals.receivesUsdc)} USDC`,
          },
        ]
      : []),
    {
      label: "Cash-out fees, at most",
      value: `${formatUsdc(totals.feeAllowanceUsdc)} USDC`,
    },
    {
      label: "Total from the wallet, at most",
      value: `${formatUsdc(totals.maxDebitUsdc)} USDC`,
    },
  ];
}

/** Whether a fresh preparation still costs what the admin reviewed. */
export function sameBillCost(
  reviewed: BillPayment,
  fresh: BillPayment,
): boolean {
  return (
    reviewed.totals.maxDebitUsdc === fresh.totals.maxDebitUsdc &&
    reviewed.totals.receivesKes === fresh.totals.receivesKes &&
    reviewed.totals.receivesUsdc === fresh.totals.receivesUsdc &&
    reviewed.bills.length === fresh.bills.length
  );
}

/** The payees inside their 24-hour hold, when the API asked for a second confirmation. */
export function holdFrom(error: unknown): PayeeChangeHold | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = payeeChangeHoldSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** The warning before the second confirmation (spec §6.19, §7.8). */
export function holdWarning(hold: PayeeChangeHold): {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
} {
  const names = listNames(hold.payees.map((payee) => payee.name));
  const theirs = hold.payees.length === 1 ? "their" : "each one’s";
  return {
    title: "Payment details changed recently",
    body: `${names} had their payment details changed in the last 24 hours. Swapped payment details are a common route for payment fraud. Before you pay, check ${theirs} new details with them directly, e.g. by phone.`,
    confirmLabel: "I’ve checked the new payment details and want to pay anyway",
  };
}

export type BillPaymentOutcome = "sent" | "paid" | "failed" | "review";

export interface BillPaymentSummary {
  readonly outcome: BillPaymentOutcome;
  readonly title: string;
  readonly body: string;
  /** The bills whose payment failed, to retry one by one. */
  readonly failedBillIds: readonly string[];
  readonly failureReason: string | null;
}

const SUMMARIES: Record<BillPaymentOutcome, { title: string; body: string }> = {
  review: {
    title: "Expendi is checking a payment",
    body: "Its outcome isn’t clear yet. Don’t pay it again: Expendi will settle it.",
  },
  failed: {
    title: "A payment failed",
    body: "Nothing reached that payee, and the USDC stays in or returns to the wallet. The other bills aren’t affected. You can retry it.",
  },
  paid: { title: "Paid", body: "Every payee has been paid." },
  sent: {
    title: "Payments sent",
    body: "M-Pesa and USDC payments usually arrive within a minute or two; banks can take longer.",
  },
};

/** The most serious outcome across the bills paid together comes first. */
export function describeBillPaymentResult(
  result: BillPaymentResult,
): BillPaymentSummary {
  const failed = result.bills.filter((bill) => bill.payout.status === "failed");
  const outcome: BillPaymentOutcome = result.bills.some(
    (bill) => bill.payout.status === "needs_review",
  )
    ? "review"
    : failed.length > 0
      ? "failed"
      : result.bills.length > 0 &&
          result.bills.every((bill) => bill.status === "paid")
        ? "paid"
        : "sent";
  return {
    outcome,
    ...SUMMARIES[outcome],
    failedBillIds: failed.map((bill) => bill.billId),
    failureReason: failed[0]?.payout.failureReason ?? null,
  };
}

/**
 * Pay all's selection with `billId` added or removed; nothing is added
 * past the most one payment covers.
 */
export function toggleSelection(
  selected: readonly string[],
  billId: string,
): string[] {
  if (selected.includes(billId)) {
    return selected.filter((id) => id !== billId);
  }
  return selected.length >= BILL_PAYMENT_MAX_BILLS
    ? [...selected]
    : [...selected, billId];
}
