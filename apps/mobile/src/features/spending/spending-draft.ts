import type {
  CompanySpending,
  CompanySpendingDetail,
  ExpenseWarning,
  OverviewHeading,
  PaidFromAccountKind,
  RecordCompanySpendingRequest,
  UpdateCompanySpendingRequest,
} from "@expendi-business/shared";

import type { ClaimDraft } from "../claims/draft";
import { formatKesCents } from "../../lib/money";
import { centsToTyped } from "../bills/bill-draft";
import { formatIsoDate } from "../claims/dates";

/** What company spending adds to the claim form (spec §6.23). */
export interface SpendingExtras {
  heading: OverviewHeading;
  paidFromAccountId: string | null;
  /** The admin chose "Save without receipt". */
  withoutReceipt: boolean;
  noReceiptReason: string;
}

export const HEADING_LABELS: Record<OverviewHeading, string> = {
  transactions: "Transactions",
  subscriptions: "Subscriptions",
  salaries: "Salaries & personnel",
  petty_cash: "Petty cash",
};

/** Transactions first: company spending's heading unless the admin picks another. */
export const SPENDING_HEADINGS: readonly OverviewHeading[] = [
  "transactions",
  "subscriptions",
  "salaries",
  "petty_cash",
];

export const ACCOUNT_KIND_LABELS: Record<PaidFromAccountKind, string> = {
  bank: "Bank account",
  card: "Card",
  mobile_money: "Mobile money",
  cash: "Cash",
  other: "Other",
};

const blankToNull = (value: string): string | null =>
  value.trim() === "" ? null : value;

export function blankSpendingDraft(today: string): ClaimDraft {
  return {
    merchant: "",
    amount: "",
    spentOn: today,
    categoryId: null,
    description: "",
    mpesaCode: "",
    etimsInvoiceNumber: "",
    etimsSupplierPin: "",
    etimsQrPayload: null,
  };
}

export const BLANK_EXTRAS: SpendingExtras = {
  heading: "transactions",
  paidFromAccountId: null,
  withoutReceipt: false,
  noReceiptReason: "",
};

export function draftFromSpending(spending: CompanySpending): ClaimDraft {
  return {
    merchant: spending.merchant,
    amount: centsToTyped(spending.amountKes),
    spentOn: spending.spentOn,
    categoryId: spending.category.id,
    description: spending.description ?? "",
    mpesaCode: spending.mpesaCode ?? "",
    etimsInvoiceNumber: spending.etimsInvoiceNumber ?? "",
    etimsSupplierPin: spending.etimsSupplierPin ?? "",
    etimsQrPayload: spending.etimsQrPayload,
  };
}

export function extrasFromSpending(spending: CompanySpending): SpendingExtras {
  return {
    heading: spending.overviewHeading,
    paidFromAccountId: spending.paidFromAccount?.id ?? null,
    withoutReceipt: spending.noReceiptReason !== null,
    noReceiptReason: spending.noReceiptReason ?? "",
  };
}

/**
 * The receipt rule as the form checks it before sending: a receipt, or
 * "Save without receipt" with a reason. Spending from a bill already has
 * the bill's files, or none at all, which is allowed.
 */
export function receiptProblem(
  receiptCount: number,
  extras: Pick<SpendingExtras, "withoutReceipt">,
  { fromBill }: { fromBill: boolean },
): string | null {
  if (receiptCount > 0 || extras.withoutReceipt || fromBill) return null;
  return "Add a receipt, or choose Save without receipt and say why.";
}

/** The reason goes only with no receipt; a receipt added later wins. */
function reasonFor(
  extras: SpendingExtras,
  receiptCount: number,
): string | undefined {
  return receiptCount === 0 && extras.withoutReceipt
    ? extras.noReceiptReason
    : undefined;
}

/** Empty optional fields are sent as null, which clears them on an edit. */
export function toRecordRequest(
  draft: ClaimDraft,
  extras: SpendingExtras,
  receiptFileIds: string[],
): RecordCompanySpendingRequest {
  return {
    receiptFileIds,
    noReceiptReason: reasonFor(extras, receiptFileIds.length) ?? null,
    merchant: draft.merchant,
    amountKes: draft.amount,
    spentOn: draft.spentOn.trim(),
    categoryId: draft.categoryId ?? "",
    description: draft.description,
    overviewHeading: extras.heading,
    paidFromAccountId: extras.paidFromAccountId ?? "",
    mpesaCode: blankToNull(draft.mpesaCode),
    etimsInvoiceNumber: blankToNull(draft.etimsInvoiceNumber),
    etimsSupplierPin: blankToNull(draft.etimsSupplierPin),
    etimsQrPayload: draft.etimsQrPayload,
  };
}

/**
 * The whole form as an edit; the API records only what changed. Spending
 * from a bill keeps the bill's amount and date, so they aren't sent, and
 * `receiptFileIds` is only the spending's own receipts, not the bill's.
 */
export function toUpdateRequest(
  spending: CompanySpendingDetail,
  draft: ClaimDraft,
  extras: SpendingExtras,
  receiptFileIds: string[],
): UpdateCompanySpendingRequest {
  const fromBill = spending.bill !== null;
  const billFiles = spending.receipts.filter(
    (receipt) => receipt.billRole !== null,
  ).length;
  const reason = reasonFor(extras, receiptFileIds.length + billFiles);
  return {
    receiptFileIds,
    ...(reason === undefined ? {} : { noReceiptReason: reason }),
    merchant: draft.merchant,
    ...(fromBill
      ? {}
      : { amountKes: draft.amount, spentOn: draft.spentOn.trim() }),
    categoryId: draft.categoryId ?? "",
    description: draft.description,
    overviewHeading: extras.heading,
    ...(extras.paidFromAccountId === null
      ? {}
      : { paidFromAccountId: extras.paidFromAccountId }),
    mpesaCode: blankToNull(draft.mpesaCode),
    etimsInvoiceNumber: blankToNull(draft.etimsInvoiceNumber),
    etimsSupplierPin: blankToNull(draft.etimsSupplierPin),
    etimsQrPayload: draft.etimsQrPayload,
  };
}

/** "15 Oct 2026 · KCB current account", for a list row. */
export function spendingSummary(spending: CompanySpending): string {
  return [
    formatIsoDate(spending.spentOn),
    spending.paidFromAccount?.name ?? "Account not specified",
  ].join(" · ");
}

/** What the admin should check, worded for company spending (spec §6.5). */
export function describeSpendingWarning(warning: ExpenseWarning): string {
  return warning.code === "near_duplicate"
    ? `You recorded KES ${formatKesCents(warning.amountKes)} on ${formatIsoDate(warning.spentOn)} too. Check it isn’t the same payment.`
    : `Paid on ${formatIsoDate(warning.spentOn)}, ${warning.ageDays} days before it was recorded.`;
}
