import type {
  CashObligation,
  FloatSummary,
  SpendingOverview,
} from "@expendi-business/shared";
import { overviewKes } from "@expendi-business/shared";

import { formatDayMonth } from "../claims/dates";
import { formatKesCents, formatUsdc } from "../../lib/money";

/** The cash check and the 30-day list on the admin's home screen (spec §6.24). */

export {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAction,
  obligationAmount,
  overviewKes as kes,
} from "@expendi-business/shared";

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

const RATE = /^(\d+)(?:\.(\d+))?$/;

/**
 * KES cents at `rate` KES per USDC, as USDC cents rounded towards zero so a
 * converted balance is never overstated. Null when the rate isn't usable.
 */
export function kesCentsToUsdcCents(cents: string, rate: string): string | null {
  const match = RATE.exec(rate);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${match[1] ?? "0"}${fraction}`);
  if (numerator === 0n) return null;
  const denominator = 10n ** BigInt(fraction.length);
  return ((BigInt(cents) * denominator) / numerator).toString();
}

export interface CashFigure {
  label: string;
  code: "KES" | "USDC";
  /** Formatted, e.g. "121,282.82". */
  value: string;
}

/**
 * Home's big figure. Covered: what's available after everything due.
 * Short: the shortfall. Without today's rate: the wallet's USDC balance.
 */
export function cashFigure(
  cash: SpendingOverview["cash"],
  currency: "KES" | "USDC",
): CashFigure {
  if (cash.status === "unknown" || cash.availableKes === null) {
    return {
      label: "In the wallet",
      code: "USDC",
      value: formatUsdc(cash.balanceUsdc),
    };
  }
  const label = cash.status === "short" ? "Short by" : "Available";
  const kesCents =
    cash.status === "short" ? (cash.shortKes ?? "0") : cash.availableKes;
  const usdcCents =
    currency === "USDC" && cash.rate !== null
      ? kesCentsToUsdcCents(kesCents, cash.rate)
      : null;
  return usdcCents === null
    ? { label, code: "KES", value: formatKesCents(kesCents) }
    : { label, code: "USDC", value: formatKesCents(usdcCents) };
}

/** What the figure leaves out, with a human date: the info under the trend line. */
export function cashExplanation(cash: SpendingOverview["cash"]): string {
  const unknown =
    cash.unknownAmounts === 0
      ? ""
      : ` Not counting ${String(cash.unknownAmounts)} ${cash.unknownAmounts === 1 ? "payment" : "payments"} with no amount yet.`;
  return `${overviewKes(cash.totalKes)} to pay through Expendi by ${formatDayMonth(cash.through)}, overdue included.${unknown} Paycrest's fees and bills paid outside Expendi aren't counted.`;
}
