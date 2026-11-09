import type {
  EtimsStatus,
  Expense,
  ExpenseListKind,
  ExpenseStatus,
  ExpenseWarning,
} from "@expendi-business/shared";
import { EXPENSE_STATUSES } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { formatIsoDate } from "~/lib/dates";
import { formatKes } from "~/lib/money";

/**
 * How Expenses and Approvals word an expense. A claim is a
 * "reimbursement" everywhere people read it.
 */
export const KIND_LABELS: Record<ExpenseListKind, string> = {
  claim: "Reimbursement",
  petty_cash: "Petty cash",
  company: "Company spending",
};

export const KIND_TAB_LABELS: Record<ExpenseListKind, string> = {
  claim: "Reimbursements",
  petty_cash: "Petty cash",
  company: "Company spending",
};

/** What a row says it is. A Card expense is listed with company spending. */
export function expenseKindLabel(
  expense: Pick<Expense, "kind" | "listKind">,
): string {
  return expense.kind === "card" ? "Card" : KIND_LABELS[expense.listKind];
}

/** The app's wording (`apps/mobile/src/features/claims/claim-status.tsx`). */
export const EXPENSE_STATUS: Record<
  ExpenseStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  submitted: { label: "Waiting for approval", tone: "waiting" },
  rejected: { label: "Rejected", tone: "rejected" },
  paying: { label: "Being paid", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  payout_failed: { label: "Payment failed", tone: "failed" },
  paid_outside: { label: "Paid before Expendi", tone: "quiet" },
  recorded: { label: "Recorded", tone: "quiet" },
};

export const STATUS_ORDER: readonly ExpenseStatus[] = EXPENSE_STATUSES;

export const ETIMS_LABELS: Record<EtimsStatus, string> = {
  attached: "Attached",
  not_required: "Not required",
  none: "None",
};

export const WARNING_LABELS: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "Possible duplicate",
  older_than_60_days: "Over 60 days old",
};

/** One marker per kind of warning, for list rows (spec §6.5). */
export function warningCodes(
  warnings: readonly ExpenseWarning[],
): ExpenseWarning["code"][] {
  return [...new Set(warnings.map((warning) => warning.code))];
}

/** What to check before approving, in a sentence (spec §6.5). */
export function describeWarning(warning: ExpenseWarning): string {
  return warning.code === "near_duplicate"
    ? `The same person submitted KES ${formatKes(warning.amountKes)} on ${formatIsoDate(warning.spentOn)} too.`
    : `Paid on ${formatIsoDate(warning.spentOn)}, ${String(warning.ageDays)} days before it was recorded.`;
}

export function warningKey(warning: ExpenseWarning): string {
  return warning.code === "near_duplicate" ? warning.expenseId : warning.code;
}

export function personName(person: {
  name: string | null;
  email: string;
}): string {
  return person.name ?? person.email;
}

export function firstName(person: {
  name: string | null;
  email: string;
}): string {
  return person.name?.trim().split(/\s+/)[0] ?? person.email;
}
