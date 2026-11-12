import { lineAmountCents, quantityToMilli } from "@expendi-business/shared";

/**
 * Invoice amounts are whole US cents in decimal strings. These helpers go
 * between what people type (dollars, percent) and what the API takes (cents,
 * basis points) with integer arithmetic only, so no amount passes through a
 * float.
 */

const DOLLARS = /^\d{1,13}(?:\.\d{1,2})?$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const MAX_BASIS_POINTS = 10_000;

/** "1,200.5" → "120050"; null when it isn't dollars and at most two decimals. */
export function dollarsToCents(input: string): string | null {
  const cleaned = input.trim().replace(/,/g, "");
  if (!DOLLARS.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}

/** "120050" → "1200.50", for an input to edit. */
export function centsToDollars(cents: string): string {
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** "120050" → "1,200.50". */
export function formatCents(cents: string): string {
  const padded = cents.padStart(3, "0");
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${padded.slice(-2)}`;
}

/** "16" → 1600, "7.5" → 750; null above 100% or when it isn't a percentage. */
export function percentToBps(input: string): number | null {
  const cleaned = input.trim();
  if (!PERCENT.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps > MAX_BASIS_POINTS ? null : bps;
}

/** 1600 → "16", 750 → "7.5". */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${String(whole)}.${fraction}`;
}

export interface PricedLine {
  readonly quantity: string;
  readonly unitPriceCents: string | null;
}

export interface InvoiceTotals {
  /** Each line's amount; null while its quantity or price isn't valid. */
  readonly lineCents: readonly (string | null)[];
  readonly subtotalCents: string;
  readonly taxCents: string;
  readonly totalCents: string;
}

/** Line amounts, subtotal, tax and total as the API will compute them: half up. */
export function computeTotals(
  lines: readonly PricedLine[],
  taxRateBps: number | null,
): InvoiceTotals {
  const lineCents = lines.map((line) =>
    line.unitPriceCents !== null && quantityToMilli(line.quantity) !== null
      ? lineAmountCents(line.quantity, BigInt(line.unitPriceCents)).toString()
      : null,
  );
  const subtotal = lineCents.reduce(
    (sum, cents) => sum + (cents === null ? 0n : BigInt(cents)),
    0n,
  );
  const tax =
    taxRateBps === null ? 0n : (subtotal * BigInt(taxRateBps) + 5000n) / 10000n;
  return {
    lineCents,
    subtotalCents: subtotal.toString(),
    taxCents: tax.toString(),
    totalCents: (subtotal + tax).toString(),
  };
}
