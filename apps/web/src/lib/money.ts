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

/**
 * KES cents as the pages show them: whole shillings drop the decimals, e.g.
 * "4850000" → "48,500" and "699950" → "6,999.50".
 */
export function formatKes(cents: string): string {
  const amount = splitMinorUnits(cents, KES_DECIMALS);
  if (amount.fraction !== "00") return join(amount);
  return `${amount.negative ? "-" : ""}${groupThousands(amount.whole)}`;
}

const MICRO = 1_000_000n;
const RATE = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

/**
 * KES cents that USDC base units convert to at `rate` (KES per USDC, as the
 * wallet reports it), rounded down; null when the rate isn't a plain decimal.
 */
export function usdcToKesCents(usdcUnits: string, rate: string): string | null {
  if (!RATE.test(rate)) return null;
  const [whole = "0", fraction = ""] = rate.split(".");
  const rateMicro = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
  return ((BigInt(usdcUnits) * rateMicro * 100n) / (MICRO * MICRO)).toString();
}

/** KES cents and USD as USDC base units, kept apart until they're shown. */
export interface CurrencyTotals {
  readonly kes: string;
  readonly usd: string;
}

/** Adds amounts per currency; a missing amount (a variable bill not entered yet) adds nothing. */
export function totalsByCurrency(
  amounts: readonly {
    readonly currency: "kes" | "usd";
    readonly amount: string | null;
  }[],
): CurrencyTotals {
  const of = (currency: "kes" | "usd") =>
    sumUnits(
      amounts
        .filter((entry) => entry.currency === currency)
        .flatMap((entry) => (entry.amount === null ? [] : [entry.amount])),
    );
  return { kes: of("kes"), usd: of("usd") };
}

export interface ApproxKesTotal {
  readonly kesCents: string;
  /** USD was converted at today's rate, so the figure is shown after a muted "≈". */
  readonly approximate: boolean;
}

/**
 * One KES figure for a total that may include USD: the USD is converted at
 * today's rate and the total is marked approximate. Null when there is USD
 * but no rate to convert it with.
 */
export function approxKesTotal({
  kes,
  usd,
  rate,
}: CurrencyTotals & { readonly rate: string | null }): ApproxKesTotal | null {
  if (BigInt(usd) === 0n) {
    return { kesCents: BigInt(kes).toString(), approximate: false };
  }
  const converted = rate === null ? null : usdcToKesCents(usd, rate);
  if (converted === null) return null;
  return {
    kesCents: (BigInt(kes) + BigInt(converted)).toString(),
    approximate: true,
  };
}
