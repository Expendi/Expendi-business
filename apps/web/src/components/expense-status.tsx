import type { JSX } from "react";

import type {
  EtimsStatus,
  ExpenseListKind,
  ExpenseStatus,
  ExpenseWarning,
} from "@expendi-business/shared";

import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";

/** The app's wording (`apps/mobile/src/features/claims/claim-status.tsx`). */
export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  submitted: "Waiting for approval",
  rejected: "Rejected",
  paying: "Being paid",
  paid: "Paid",
  payout_failed: "Payment failed",
  paid_outside: "Paid before Expendi",
  recorded: "Recorded",
};

const STATUS_STYLES: Partial<Record<ExpenseStatus, string>> = {
  rejected: "bg-amber-100 text-amber-900",
  payout_failed: "bg-error-50 text-error-700",
  paid: "bg-emerald-50 text-emerald-800",
};

export const EXPENSE_LIST_KIND_LABELS: Record<ExpenseListKind, string> = {
  claim: "Claim",
  petty_cash: "Petty cash",
  company: "Company spending",
};

export const ETIMS_STATUS_LABELS: Record<EtimsStatus, string> = {
  attached: "Attached",
  not_required: "Not required",
  none: "None",
};

const badgeClass = "inline-block rounded px-1.5 py-0.5 text-xs font-medium";

export function ExpenseStatusBadge({
  status,
}: {
  status: ExpenseStatus;
}): JSX.Element {
  return (
    <span
      className={`${badgeClass} ${STATUS_STYLES[status] ?? "bg-stone-100 text-stone-700"}`}
    >
      {EXPENSE_STATUS_LABELS[status]}
    </span>
  );
}

const WARNING_BADGES: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "Possible duplicate",
  older_than_60_days: "Over 60 days old",
};

/** One badge per kind of warning, for lists (spec §6.5). */
export function WarningBadges({
  warnings,
}: {
  warnings: readonly ExpenseWarning[];
}): JSX.Element | null {
  const codes = [...new Set(warnings.map((warning) => warning.code))];
  if (codes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {codes.map((code) => (
        <span
          key={code}
          className={`${badgeClass} bg-amber-100 text-amber-900`}
        >
          {WARNING_BADGES[code]}
        </span>
      ))}
    </span>
  );
}

export function describeWarning(warning: ExpenseWarning): string {
  return warning.code === "near_duplicate"
    ? `The same person claimed KES ${formatKesCents(warning.amountKes)} on ${formatIsoDate(warning.spentOn)} too.`
    : `Paid on ${formatIsoDate(warning.spentOn)}, ${String(warning.ageDays)} days before it was recorded.`;
}

/** What to check before approving (spec §6.5). */
export function WarningList({
  warnings,
}: {
  warnings: readonly ExpenseWarning[];
}): JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-medium">Check before approving</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li
            key={
              warning.code === "near_duplicate"
                ? warning.expenseId
                : warning.code
            }
          >
            {describeWarning(warning)}
          </li>
        ))}
      </ul>
    </div>
  );
}
