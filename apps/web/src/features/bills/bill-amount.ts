import type { BillCurrency, PayeeMethod } from "@expendi-business/shared";
import {
  currencyForPayeeMethod,
  parseKesToCents,
  parseUsdToUsdcUnits,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import { formatKesCents, formatUsdc } from "~/lib/money";

/**
 * Copied from `apps/mobile/src/features/bills/bill-amount.ts`. A bill's
 * amount (spec §6.19): KES cents, or for a payee paid in USDC, USD as USDC
 * base units, paid exactly.
 */
export interface BillAmountFields {
  readonly currency: BillCurrency;
  readonly amountKes: string | null;
  readonly amountUsdc: string | null;
}

export const CURRENCY_LABELS: Readonly<Record<BillCurrency, string>> = {
  kes: "KES",
  usd: "USD",
};

/** The amount in its currency's minor units, or null while a variable bill has none. */
export function storedAmount(amount: BillAmountFields): string | null {
  return amount.currency === "usd" ? amount.amountUsdc : amount.amountKes;
}

/** "KES 1,500.00" or "USD 120.50"; null while there's no amount. */
export function formatBillAmount(amount: BillAmountFields): string | null {
  const stored = storedAmount(amount);
  if (stored === null) return null;
  return amount.currency === "usd"
    ? `USD ${formatUsdc(stored)}`
    : `KES ${formatKesCents(stored)}`;
}

/** Minor units as the person would type them back, e.g. KES "1500050" → "15000.50". */
export function toTyped(currency: BillCurrency, stored: string): string {
  const cents =
    currency === "usd"
      ? (BigInt(stored) / USDC_UNITS_PER_US_CENT).toString()
      : stored;
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** The typed amount in the currency's minor units, as the API will store it, or null. */
export function parseTyped(
  currency: BillCurrency,
  typed: string,
): string | null {
  const parsed =
    currency === "usd" ? parseUsdToUsdcUnits(typed) : parseKesToCents(typed);
  return parsed?.toString() ?? null;
}

/**
 * The currency a payee's bills are in: USD when they're paid in USDC.
 * `fallback` until their payment details are added.
 */
export function currencyOfPayee(
  method: PayeeMethod | null | undefined,
  fallback: BillCurrency,
): BillCurrency {
  return method === null || method === undefined
    ? fallback
    : currencyForPayeeMethod(method);
}

const MICRO = 1_000_000n;
const RATE = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

/**
 * KES cents that `usdcUnits` convert to at Paycrest's `rate` (KES per
 * USDC), rounded down, as the API's `kesCentsFor` values a USD bill; null
 * if the rate isn't a decimal it can read.
 */
export function kesCentsAtRate(usdcUnits: string, rate: string): string | null {
  if (!RATE.test(rate)) return null;
  const [whole = "0", fraction = ""] = rate.split(".");
  const rateMicro = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
  return ((BigInt(usdcUnits) * rateMicro * 100n) / (MICRO * MICRO)).toString();
}
