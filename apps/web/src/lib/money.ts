/**
 * Copied from `apps/mobile/src/lib/money.ts`. The API sends money as integer
 * minor units in decimal strings (KES cents, USDC base units); these format
 * them with string arithmetic, so no amount ever passes through a float.
 */

const USDC_DECIMALS = 6;
const KES_DECIMALS = 2;
const INTEGER = /^-?\d+$/;

interface SplitAmount {
  negative: boolean;
  whole: string;
  fraction: string;
}

function splitMinorUnits(amount: string, decimals: number): SplitAmount {
  if (!INTEGER.test(amount)) {
    throw new Error(`Expected an integer amount, got "${amount}"`);
  }
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount)
    .replace(/^0+(?=\d)/, "")
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  return { negative: negative && /[1-9]/.test(digits), whole, fraction };
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function join({ negative, whole, fraction }: SplitAmount): string {
  return `${negative ? "-" : ""}${groupThousands(whole)}.${fraction}`;
}

/**
 * USDC base units (6 decimals) as a display string, e.g. "1234500000" →
 * "1,234.50". Shows every non-zero decimal so a balance is never rounded up.
 */
export function formatUsdc(baseUnits: string): string {
  const amount = splitMinorUnits(baseUnits, USDC_DECIMALS);
  return join({
    ...amount,
    fraction: amount.fraction.replace(/0+$/, "").padEnd(KES_DECIMALS, "0"),
  });
}

/** KES cents as a display string, e.g. "16012345" → "160,123.45". */
export function formatKesCents(cents: string): string {
  return join(splitMinorUnits(cents, KES_DECIMALS));
}

/** Adds integer amounts given as decimal strings, e.g. claims' KES cents. */
export function sumUnits(amounts: readonly string[]): string {
  return amounts
    .reduce((total, amount) => total + BigInt(amount), 0n)
    .toString();
}
