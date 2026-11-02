/**
 * KES as people type it: whole shillings, optionally grouped in thousands
 * with commas, and at most 2 decimals, e.g. "1,500.50", "1500" or "0.5".
 */
const KES_AMOUNT_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

/**
 * A typed KES amount in integer cents, using string and bigint maths only so
 * no float ever rounds it: "1,500.50" → 150050n, "0.5" → 50n. Null for
 * anything else, including a sign, a currency label or more than 2 decimals.
 */
export function parseKesToCents(input: string): bigint | null {
  const amount = input.trim();
  if (!KES_AMOUNT_PATTERN.test(amount)) return null;
  const [whole = "", fraction = ""] = amount.replace(/,/g, "").split(".");
  return BigInt(`${whole}${fraction.padEnd(2, "0")}`);
}

/** Positive integer KES cents for people to read, e.g. 150050n → "KES 1,500.50". */
export function formatKesAmount(cents: bigint): string {
  const digits = cents.toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `KES ${whole}.${digits.slice(-2)}`;
}
