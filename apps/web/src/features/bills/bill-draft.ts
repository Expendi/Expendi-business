import type {
  Bill,
  BillCurrency,
  BillHeading,
  CreateBillRequest,
  UpdateBillRequest,
} from "@expendi-business/shared";

import {
  currencyOfPayee,
  parseTyped,
  storedAmount,
  toTyped,
} from "./bill-amount";

/** The bill form as typed; the API parses the amount into integer units. */
export interface BillDraft {
  payeeId: string | null;
  variable: boolean;
  /** USD for a payee paid in USDC (spec §6.19), KES otherwise. */
  currency: BillCurrency;
  amount: string;
  dueOn: string;
  /** Null follows the payee: Subscriptions for a subscription vendor. */
  heading: BillHeading | null;
  categoryId: string | null;
  reference: string;
  notes: string;
  /** Only asked for when a fixed amount changes. */
  adjustmentReason: string;
}

export const blankToNull = (value: string): string | null =>
  value.trim() === "" ? null : value;

/**
 * The bill as its form starts. The amount is in the payee's currency as it
 * is now: if their method changed between KES and USDC since, it's blank,
 * to be entered again in theirs.
 */
export function draftFromBill(bill: Bill): BillDraft {
  const currency = currencyOfPayee(bill.payee.method, bill.currency);
  const stored = currency === bill.currency ? storedAmount(bill) : null;
  return {
    payeeId: bill.payee.id,
    variable: bill.variable,
    currency,
    amount: stored === null ? "" : toTyped(currency, stored),
    dueOn: bill.dueOn,
    heading:
      bill.overviewHeading === "transactions" ||
      bill.overviewHeading === "subscriptions"
        ? bill.overviewHeading
        : null,
    categoryId: bill.category.id,
    reference: bill.reference ?? "",
    notes: bill.notes ?? "",
    adjustmentReason: "",
  };
}

/** KES cents as the person would type them back, e.g. "1500050" → "15000.50". */
export function centsToTyped(cents: string): string {
  return toTyped("kes", cents);
}

/** The typed amount under the field its currency takes. */
function amountField(
  draft: BillDraft,
): { amountKes: string | null } | { amountUsd: string | null } {
  const amount = blankToNull(draft.amount);
  return draft.currency === "usd"
    ? { amountUsd: amount }
    : { amountKes: amount };
}

export function toCreateRequest(
  draft: BillDraft,
  invoiceFileIds: string[],
): CreateBillRequest {
  return {
    payeeId: draft.payeeId ?? "",
    variable: draft.variable,
    ...amountField(draft),
    dueOn: draft.dueOn.trim(),
    overviewHeading: draft.heading ?? undefined,
    categoryId: draft.categoryId ?? "",
    reference: blankToNull(draft.reference),
    notes: blankToNull(draft.notes),
    invoiceFileIds,
  };
}

/** Whether the typed amount differs from the bill's, in its currency's units. */
export function amountChanged(bill: Bill, draft: BillDraft): boolean {
  const typed = blankToNull(draft.amount);
  const stored = storedAmount(bill);
  if (draft.currency !== bill.currency)
    return typed !== null || stored !== null;
  if (typed === null) return stored !== null;
  return parseTyped(draft.currency, typed) !== stored;
}

/** Only the fields that changed; an empty request changes nothing. */
export function toUpdateRequest(
  bill: Bill,
  draft: BillDraft,
): UpdateBillRequest {
  const request: UpdateBillRequest = {};
  if (draft.payeeId !== null && draft.payeeId !== bill.payee.id) {
    request.payeeId = draft.payeeId;
  }
  if (amountChanged(bill, draft)) {
    Object.assign(request, amountField(draft));
    if (!bill.variable) request.adjustmentReason = draft.adjustmentReason;
  }
  if (draft.dueOn.trim() !== bill.dueOn) request.dueOn = draft.dueOn.trim();
  if (draft.heading !== null && draft.heading !== bill.overviewHeading) {
    request.overviewHeading = draft.heading;
  }
  if (draft.categoryId !== null && draft.categoryId !== bill.category.id) {
    request.categoryId = draft.categoryId;
  }
  const reference = blankToNull(draft.reference)?.trim() ?? null;
  if (reference !== bill.reference) request.reference = reference;
  const notes = blankToNull(draft.notes)?.trim() ?? null;
  if (notes !== bill.notes) request.notes = notes;
  return request;
}
