/**
 * USDC amounts typed by the admin, turned into 6-decimal base units with
 * string arithmetic only: floats never touch money.
 */

const USDC_DECIMALS = 6;
const AMOUNT = /^(\d*)(?:\.(\d*))?$/;

export type UsdcAmountResult =
  | { readonly ok: true; readonly baseUnits: string }
  | { readonly ok: false; readonly error: string };

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/** Compares two non-negative integer strings: -1, 0 or 1. */
export function compareBaseUnits(a: string, b: string): -1 | 0 | 1 {
  const left = stripLeadingZeros(a);
  const right = stripLeadingZeros(b);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * "12.5" → "12500000". Accepts a comma as the decimal mark; refuses more
 * than 6 decimals, zero, and anything above `availableBaseUnits`.
 */
export function parseUsdcAmount(
  input: string,
  availableBaseUnits: string,
): UsdcAmountResult {
  const match = AMOUNT.exec(input.trim().replace(",", "."));
  const whole = match?.[1] ?? "";
  const fraction = match?.[2] ?? "";
  if (!match || whole.length + fraction.length === 0) {
    return { ok: false, error: "Enter an amount in USDC." };
  }
  if (fraction.length > USDC_DECIMALS) {
    return { ok: false, error: "USDC has at most 6 decimal places." };
  }
  const baseUnits = stripLeadingZeros(
    `${whole}${fraction.padEnd(USDC_DECIMALS, "0")}`,
  );
  if (baseUnits === "0") {
    return { ok: false, error: "Enter an amount above zero." };
  }
  if (compareBaseUnits(baseUnits, availableBaseUnits) > 0) {
    return { ok: false, error: "That's more than the wallet holds." };
  }
  return { ok: true, baseUnits };
}

/** `0x1234…abcd`: enough to recognise an address at a glance. */
export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}
