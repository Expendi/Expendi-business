import type { CashObligation, FloatSummary } from "@expendi-business/shared";

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
