import type { PreferenceKey, PreferenceValueMap } from "./preferences-config";
import type { ResolvedThemeMode } from "./theme";
import { PREFERENCE_REGISTRY } from "./preferences-config";
import { applyThemeMode } from "./theme-utils";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** Mirrors a preference on `<html>`; returns the resolved mode for `theme_mode`. */
export function applyPreference<K extends PreferenceKey>(
  key: K,
  value: PreferenceValueMap[K],
): ResolvedThemeMode | undefined {
  if (key === "theme_mode") {
    return applyThemeMode(value as PreferenceValueMap["theme_mode"]);
  }
  document.documentElement.setAttribute(
    PREFERENCE_REGISTRY[key].attribute,
    value,
  );
  return undefined;
}

/** Saves a preference in its cookie, so the next server render matches. */
export function persistPreference<K extends PreferenceKey>(
  key: K,
  value: PreferenceValueMap[K],
): void {
  document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=${String(ONE_YEAR_IN_SECONDS)}; samesite=lax`;
}
