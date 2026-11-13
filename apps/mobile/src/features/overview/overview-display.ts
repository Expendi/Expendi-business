import type {
  CashObligation,
  FloatSummary,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  cashCardBillsLine,
  formatUsdCents,
  obligationAmount as obligationAmountInKes,
} from "@expendi-business/shared";

import { maskedCardNumber } from "../cards/card-display";

/** The cash check and the 30-day list on the admin's home screen (spec §6.24). */

export {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAction,
  overviewKes as kes,
} from "@expendi-business/shared";

export interface CashCardLine {
  readonly text: string;
  readonly short: boolean;
}

/**
 * The bills company-held cards pay before the cash check's date, against
 * the Card balance they're paid from rather than the wallet. Null when no
 * card pays anything in that time. The Card balance is loaded only on the
 * web dashboard, so a shortfall says where.
 */
export function cashCardLine(
  cash: SpendingOverview["cash"],
): CashCardLine | null {
  const text = cashCardBillsLine(cash);
  if (text === null) return null;
  return cash.cardBills?.short
    ? {
        text: `${text}. Load the Card balance on the web dashboard.`,
        short: true,
      }
    : { text, short: false };
}

/**
 * How a due payment gets paid. The API sends a company-held card's as
 * `outside` for apps built before cards, so the card decides first.
 */
export function obligationPaidBy(
  row: Pick<CashObligation, "payVia" | "card">,
): string {
  if (row.card) {
    return `Automatic · card ${maskedCardNumber(row.card.lastFour)}`;
  }
  return row.payVia === "outside" ? "Paid outside Expendi" : "Through Expendi";
}

/**
 * A company-held card is charged whatever the payee charges, in USD from
 * the Card balance, so its amount is the USD estimate the Card balance is
 * checked against, never the KES the cash check values it at.
 */
export function obligationAmount(row: CashObligation): string {
  if (!row.card) return obligationAmountInKes(row);
  return row.amountUsdCents == null
    ? "No estimate"
    : `About ${formatUsdCents(BigInt(row.amountUsdCents))}`;
}

export type ObligationTarget =
  | { readonly screen: "bill"; readonly billId: string }
  | { readonly screen: "payroll_run"; readonly runId: string }
  | { readonly screen: "salaries" }
  | { readonly screen: "recurring_item"; readonly itemId: string };

/** Where Pay, or View for a forecast, opens. */
export function obligationTarget(row: CashObligation): ObligationTarget {
  switch (row.kind) {
    case "bill":
      return { screen: "bill", billId: row.id };
    case "payroll":
      return { screen: "payroll_run", runId: row.id };
    case "forecast":
      return row.heading === "salaries"
        ? { screen: "salaries" }
        : { screen: "recurring_item", itemId: row.id };
  }
}

/** `month` is `YYYY-MM`. */
export function shiftMonth(month: string, step: number): string {
  const [year = 0, number = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + step, 1))
    .toISOString()
    .slice(0, 7);
}

/** What's left across the person's open floats, KES cents. */
export function openFloatLeft(
  floats: readonly Pick<FloatSummary, "status" | "leftKes">[],
): string {
  return floats
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + BigInt(row.leftKes), 0n)
    .toString();
}
