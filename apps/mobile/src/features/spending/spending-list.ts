import type { CompanySpending, ExpenseWarning } from "@expendi-business/shared";

import { formatShortDate } from "../claims/dates";
import { HEADING_LABELS } from "./spending-draft";

const WARNING_WORDS: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "possible duplicate",
  older_than_60_days: "over 60 days old",
};

export interface SpendingRowMeta {
  text: string;
  /** Something needs the admin's attention: no receipt or a warning. */
  needsAttention: boolean;
}

/** "Subscriptions · Thu 5 Nov · KCB current account · no receipt · from a bill". */
export function spendingRowMeta(
  spending: CompanySpending,
  today: string,
): SpendingRowMeta {
  const warnings = [...new Set(spending.warnings.map((row) => row.code))].map(
    (code) => WARNING_WORDS[code],
  );
  const flags = [
    spending.noReceipt ? "no receipt" : null,
    ...warnings,
    spending.bill ? "from a bill" : null,
  ].filter((flag) => flag !== null);
  const text = [
    HEADING_LABELS[spending.overviewHeading],
    formatShortDate(spending.spentOn, today),
    spending.paidFromAccount?.name ?? "Account not specified",
    ...flags,
  ].join(" · ");
  return {
    text,
    needsAttention: spending.noReceipt || warnings.length > 0,
  };
}
