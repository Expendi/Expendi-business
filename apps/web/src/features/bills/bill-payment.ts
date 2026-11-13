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
  billPaymentResultSchema,
  billPaymentSchema,
  currencyForPayeeMethod,
  payeeChangeHoldSchema,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { ApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatKesCents, formatUsdc } from "~/lib/money";
import { storedAmount } from "./bill-amount";

/**
 * Pay and Pay all (spec §6.20), as the app runs them
 * (`apps/mobile/src/features/bills/bill-payment.ts`): which bills can be
 * paid, the requests, the cost preview, the 24-hour hold's second
 * confirmation (spec §6.19) and what a payment's outcome means.
 */

export interface PreviewRow {
  readonly label: string;
  readonly value: string;
}

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

/**
 * A bill still owed that a company-held card pays when its merchant
 * charges it (spec §6.20): nobody pays it through Expendi.
 */
export function automaticCardOf(
  bill: Pick<Bill, "status" | "card">,
): NonNullable<Bill["card"]> | null {
  return isUnpaid(bill.status) ? (bill.card ?? null) : null;
}

/**
 * A payment whose schedule ended still has its card pay the bill it left
 * owed, unless it's paused; an API that doesn't say whether it's paused
 * is taken to have it declined.
 */
const endedWithLastBill = (bill: Pick<Bill, "recurring">): boolean =>
  bill.recurring?.state === "ended" && bill.recurring.active === true;

/**
 * Why a bill a company-held card was to pay won't be paid by it: its
 * recurring payment is paused, or has ended and is paused too, so the card
 * declines the merchant, or the card is frozen or closed. Null while the
 * card will pay it.
 */
export function cardWontPayReason(
  bill: Pick<Bill, "status" | "card" | "recurring" | "payee">,
): string | null {
  const card = automaticCardOf(bill);
  if (card === null) return null;
  const state = bill.recurring?.state;
  if (state === "paused") {
    return `Paused: card purchases from ${bill.payee.name} are declined.`;
  }
  if (state === "ended" && !endedWithLastBill(bill)) {
    return `Ended: card purchases from ${bill.payee.name} are declined.`;
  }
  if (card.state === "frozen" || card.state === "closed") {
    return `Card •••• ${card.lastFour} is ${card.state}.`;
  }
  return null;
}

/** "Card •••• 1234 pays this last bill, and nothing after it." on an ended payment's last bill. */
export function lastCardBillNote(
  bill: Pick<Bill, "status" | "card" | "recurring">,
): string | null {
  const card = automaticCardOf(bill);
  if (card?.state !== "open" || !endedWithLastBill(bill)) return null;
  return `Card •••• ${card.lastFour} pays this last bill, and nothing after it.`;
}

/**
 * Whether the dashboard offers to pay the bill through Expendi: unpaid,
 * not a salary (those go with their payroll run), not paid by a
 * company-held card, a payee Expendi can pay, and its amount entered in
 * the payee's currency. The API checks it all again.
 */
export function isPayable(bill: Bill): boolean {
  const { method } = bill.payee;
  return (
    isUnpaid(bill.status) &&
    bill.payrollRunId === null &&
    automaticCardOf(bill) === null &&
    method !== null &&
    method !== "outside" &&
    !bill.payee.archived &&
    currencyForPayeeMethod(method) === bill.currency &&
    storedAmount(bill) !== null
  );
}

/** Why an unpaid bill can't be paid through Expendi yet, or null; a card-paid one explains itself. */
export function unpayableReason(bill: Bill): string | null {
  if (!isUnpaid(bill.status) || isPayable(bill)) return null;
  if (automaticCardOf(bill) !== null) return null;
  if (bill.payrollRunId !== null) return "Paid with its payroll run.";
  if (bill.payee.archived) return "The payee is archived.";
  const { method } = bill.payee;
  if (method === null) return "Add the payee's payment details first.";
  if (method === "outside") return "Paid outside Expendi: mark it paid.";
  if (currencyForPayeeMethod(method) !== bill.currency) {
    return "The payee's payment method changed: enter the amount again.";
  }
  return "Enter the amount first.";
}

export interface BillPaymentRequest {
  readonly billIds: readonly string[];
  /** A retry of one bill whose payment failed. */
  readonly retry: boolean;
  /** Only after the admin confirmed the 24-hour warning (spec §6.19). */
  readonly secondConfirmation: boolean;
}

const billsPath = (organizationId: string) =>
  `/organizations/${organizationId}/bills` as const;

/**
 * One payout per bill and one challenge for them all. The API returns the
 * same payouts each time, so preparing again never adds one.
 */
export function prepareBillPayment(
  api: ApiClient,
  organizationId: string,
  { billIds, retry, secondConfirmation }: BillPaymentRequest,
): Promise<BillPayment> {
  const path = billsPath(organizationId);
  const [billId] = billIds;
  return retry && billId !== undefined
    ? api.post(
        `${path}/${billId}/retry`,
        { secondConfirmation },
        billPaymentSchema,
      )
    : api.post(
        `${path}/payment`,
        { billIds, secondConfirmation },
        billPaymentSchema,
      );
}

export function confirmBillPayment(
  api: ApiClient,
  organizationId: string,
  challengeId: string,
  response: PasskeyAssertion,
): Promise<BillPaymentResult> {
  return api.post(
    `${billsPath(organizationId)}/payment/${challengeId}/confirm`,
    { response },
    billPaymentResultSchema,
  );
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

/** The cost changed between the review and the passkey prompt; `fresh` is the new one. */
export class CostChangedError<T> extends Error {
  override readonly name = "CostChangedError";

  constructor(readonly fresh: T) {
    super(
      "The cost changed since you reviewed it. Nothing was sent. Review it again.",
    );
  }
}

export function describePaymentError(error: unknown): string {
  return error instanceof CostChangedError
    ? error.message
    : describeApprovalError(error);
}

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
            label: "In KES, at today’s rate",
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
    body: "Nothing reached that payee, and the USDC stays in or returns to the wallet. The other bills aren’t affected. You can retry it under Payment failed.",
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
