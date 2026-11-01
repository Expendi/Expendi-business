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
