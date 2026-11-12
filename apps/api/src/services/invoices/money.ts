import { lineAmountCents } from "@expendi-business/shared";

/**
 * Invoice money maths, exact in bigints: no floats anywhere, so a total is
 * the same wherever it is computed. `lineAmountCents` lives in shared so the
 * form and the API agree.
 */
export { lineAmountCents };

/** One US dollar is one USDC: 100 cents is 1_000_000 base units. */
const USDC_UNITS_PER_CENT = 10_000n;

export interface InvoiceLineAmounts {
  readonly quantity: string;
  readonly unitPriceCents: bigint;
}

export interface InvoiceTotals {
  readonly lineAmounts: readonly bigint[];
  readonly subtotalCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
}

/**
 * The sum of the lines, tax on that sum rounded half up to the cent, and
 * their total. `taxRateBps` is basis points; null means no tax.
 */
export function invoiceTotals(
  lines: readonly InvoiceLineAmounts[],
  taxRateBps: number | null,
): InvoiceTotals {
  const lineAmounts = lines.map((line) =>
    lineAmountCents(line.quantity, line.unitPriceCents),
  );
  const subtotalCents = lineAmounts.reduce((sum, amount) => sum + amount, 0n);
  const taxCents =
    taxRateBps === null
      ? 0n
      : (subtotalCents * BigInt(taxRateBps) + 5_000n) / 10_000n;
  return {
    lineAmounts,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

/** USDC base units (6 decimals) for an amount in cents. */
export function centsToUsdc(cents: bigint): bigint {
  return cents * USDC_UNITS_PER_CENT;
}
