import type { CountryCode } from "libphonenumber-js";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export const DEFAULT_REGION: CountryCode = "KE";

/**
 * Normalise a phone number to E.164 (`0712 345 678` → `+254712345678`), or
 * `null` if it isn't a valid number. National formats are read against
 * `defaultRegion`; numbers already in international form ignore it.
 * Ported from the consumer backend's phone-normalization.
 */
export function normalizeToE164(
  raw: string,
  defaultRegion: CountryCode = DEFAULT_REGION,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  return parsed?.isValid() ? parsed.number : null;
}

const KENYAN_MOBILE = /^\+254[17]\d{8}$/;

/**
 * A Kenyan mobile number in E.164 (`07xx…`/`01xx…` → `+2547xx…`/`+2541xx…`),
 * or `null` for anything else. Payouts go to M-Pesa, so payout numbers must
 * be Kenyan (spec §6.18).
 */
export function toKenyanMobile(raw: string): string | null {
  const e164 = normalizeToE164(raw, "KE");
  return e164 !== null && KENYAN_MOBILE.test(e164) ? e164 : null;
}
