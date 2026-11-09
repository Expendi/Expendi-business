/**
 * Exact money arithmetic for Paycrest (spec §6.7). Paycrest sends amounts
 * and rates as decimal strings; everything here is bigint so no float ever
 * touches money (handoff rule 1).
 *
 * - USDC: 6-decimal base units.
 * - KES: cents.
 * - Rates: KES per USDC, at most 6 decimals, scaled to micro-units.
 */

const DECIMAL_6 = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const MICRO = 1_000_000n;
const CENTS_PER_SHILLING = 100n;

export class InvalidDecimal extends Error {
  constructor(value: string) {
    super(`Not a decimal with at most 6 places: "${value}"`);
  }
}

/** "128.68" → 128_680_000n. Rejects negatives, exponents and >6 decimals. */
export function toMicro(value: string): bigint {
  if (!DECIMAL_6.test(value)) throw new InvalidDecimal(value);
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

/** 11_656_823n → "11.656823"; trailing zeros dropped. */
export function fromMicro(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / MICRO;
  const fraction = (magnitude % MICRO).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${sign}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

export const ceilDiv = (dividend: bigint, divisor: bigint): bigint =>
  (dividend + divisor - 1n) / divisor;

/**
 * M-Pesa only moves whole shillings, so a payout is the claim rounded up:
 * KES 1,499.50 → KES 1,500 (spec §6.7). Returned in cents.
 */
export function roundUpToWholeShilling(kesCents: bigint): bigint {
  if (kesCents <= 0n) throw new RangeError("KES amount must be positive");
  return ceilDiv(kesCents, CENTS_PER_SHILLING) * CENTS_PER_SHILLING;
}

/**
 * The least USDC (base units) that converts to at least `kesCents` at
 * `rate`: rounded up, so the recipient is never short.
 * usdc / 1e6 × rate ≥ kesCents / 100
 */
export function usdcCovering(kesCents: bigint, rate: string): bigint {
  const rateMicro = toMicro(rate);
  if (rateMicro === 0n) throw new RangeError("Rate must be positive");
  return ceilDiv(kesCents * MICRO * MICRO, rateMicro * CENTS_PER_SHILLING);
}

/**
 * KES cents that `usdCents` US cents convert to at `rate`, rounded to the
 * nearest cent: what a Card expense records at settlement.
 */
export function kesCentsFromUsdCents(usdCents: bigint, rate: string): bigint {
  return (usdCents * toMicro(rate) + MICRO / 2n) / MICRO;
}

/** KES cents that `usdc` (base units) converts to at `rate`, rounded down. */
export function kesCentsFor(usdc: bigint, rate: string): bigint {
  return (usdc * toMicro(rate) * CENTS_PER_SHILLING) / (MICRO * MICRO);
}
