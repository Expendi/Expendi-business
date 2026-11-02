import type {
  Bill,
  BillHeading,
  CreateBillRequest,
  UpdateBillRequest,
} from "@expendi-business/shared";
import { parseKesToCents } from "@expendi-business/shared";

/** The bill form as typed; the API parses the amount into integer cents. */
export interface BillDraft {
  payeeId: string | null;
  variable: boolean;
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

export function draftFromBill(bill: Bill): BillDraft {
  return {
    payeeId: bill.payee.id,
    variable: bill.variable,
    amount: bill.amountKes === null ? "" : centsToTyped(bill.amountKes),
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
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

export function toCreateRequest(
  draft: BillDraft,
  invoiceFileIds: string[],
): CreateBillRequest {
  return {
    payeeId: draft.payeeId ?? "",
    variable: draft.variable,
    amountKes: blankToNull(draft.amount),
    dueOn: draft.dueOn.trim(),
    overviewHeading: draft.heading ?? undefined,
    categoryId: draft.categoryId ?? "",
    reference: blankToNull(draft.reference),
    notes: blankToNull(draft.notes),
    invoiceFileIds,
  };
}

/** Whether the typed amount differs from the bill's, compared in cents. */
export function amountChanged(bill: Bill, draft: BillDraft): boolean {
  const typed = blankToNull(draft.amount);
  if (typed === null) return bill.amountKes !== null;
  return parseKesToCents(typed)?.toString() !== bill.amountKes;
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
    request.amountKes = blankToNull(draft.amount);
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
