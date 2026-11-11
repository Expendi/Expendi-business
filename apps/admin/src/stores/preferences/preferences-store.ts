import { createStore } from "zustand/vanilla";

import type {
  PreferenceKey,
  PreferenceValueMap,
} from "~/lib/preferences/preferences-config";
import type { ResolvedThemeMode } from "~/lib/preferences/theme";
import {
  applyPreference,
  persistPreference,
} from "~/lib/preferences/preferences-client";
import {
  PREFERENCE_DEFAULTS,
  PREFERENCE_KEYS,
} from "~/lib/preferences/preferences-config";

export interface PreferencesState {
  values: PreferenceValueMap;
  resolvedThemeMode: ResolvedThemeMode;
  setPreference: <K extends PreferenceKey>(
    key: K,
    value: PreferenceValueMap[K],
  ) => void;
  resetPreferences: () => void;
}

export function createPreferencesStore(initialValues: PreferenceValueMap) {
  return createStore<PreferencesState>()((set) => ({
    values: initialValues,
    resolvedThemeMode: initialValues.theme_mode === "dark" ? "dark" : "light",

    setPreference: (key, value) => {
      const resolvedThemeMode = applyPreference(key, value);
      persistPreference(key, value);
      set((state) => ({
        values: { ...state.values, [key]: value },
        ...(resolvedThemeMode ? { resolvedThemeMode } : {}),
      }));
    },

    resetPreferences: () => {
      let resolvedThemeMode: ResolvedThemeMode = "light";
      function reset<K extends PreferenceKey>(key: K) {
        const value = PREFERENCE_DEFAULTS[key];
        resolvedThemeMode = applyPreference(key, value) ?? resolvedThemeMode;
        persistPreference(key, value);
      }
      for (const key of PREFERENCE_KEYS) reset(key);
      set({ values: { ...PREFERENCE_DEFAULTS }, resolvedThemeMode });
    },
  }));
}
