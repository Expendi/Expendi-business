import { FONT_VALUES } from "~/lib/fonts/options";
import {
  CONTENT_LAYOUT_VALUES,
  NAVBAR_STYLE_VALUES,
  SIDEBAR_COLLAPSIBLE_VALUES,
  SIDEBAR_VARIANT_VALUES,
} from "./layout";
import { THEME_MODE_VALUES, THEME_PRESET_VALUES } from "./theme";

interface PreferenceDefinition<
  Values extends readonly string[],
  Attribute extends `data-${string}`,
> {
  values: Values;
  defaultValue: Values[number];
  attribute: Attribute;
}

function definePreference<
  const Values extends readonly string[],
  const Attribute extends `data-${string}`,
>(
  definition: PreferenceDefinition<Values, Attribute>,
): PreferenceDefinition<Values, Attribute> {
  return definition;
}

/**
 * Every layout preference, saved in a cookie of the same name so the root
 * layout can render it on the server, and mirrored on `<html>` as its
 * `data-*` attribute for CSS.
 */
export const PREFERENCE_REGISTRY = {
  theme_mode: definePreference({
    values: THEME_MODE_VALUES,
    defaultValue: "light",
    attribute: "data-theme-mode",
  }),
  theme_preset: definePreference({
    values: THEME_PRESET_VALUES,
    defaultValue: "default",
    attribute: "data-theme-preset",
  }),
  font: definePreference({
    values: FONT_VALUES,
    defaultValue: "outfit",
    attribute: "data-font",
  }),
  content_layout: definePreference({
    values: CONTENT_LAYOUT_VALUES,
    defaultValue: "centered",
    attribute: "data-content-layout",
  }),
  navbar_style: definePreference({
    values: NAVBAR_STYLE_VALUES,
    defaultValue: "sticky",
    attribute: "data-navbar-style",
  }),
  sidebar_variant: definePreference({
    values: SIDEBAR_VARIANT_VALUES,
    defaultValue: "inset",
    attribute: "data-sidebar-variant",
  }),
  sidebar_collapsible: definePreference({
    values: SIDEBAR_COLLAPSIBLE_VALUES,
    defaultValue: "icon",
    attribute: "data-sidebar-collapsible",
  }),
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_REGISTRY;

export type PreferenceValueMap = {
  [K in PreferenceKey]: (typeof PREFERENCE_REGISTRY)[K]["values"][number];
};

export const PREFERENCE_KEYS = Object.freeze(
  Object.keys(PREFERENCE_REGISTRY) as PreferenceKey[],
);

export const PREFERENCE_DEFAULTS = Object.fromEntries(
  PREFERENCE_KEYS.map((key) => [key, PREFERENCE_REGISTRY[key].defaultValue]),
) as PreferenceValueMap;

/** The sidebar's own open/closed cookie, written by `ui/sidebar`. */
export const SIDEBAR_STATE_COOKIE = "sidebar_state";

/** The saved value when it is one of the allowed ones, else the default. */
export function parsePreference<K extends PreferenceKey>(
  key: K,
  rawValue: string | null | undefined,
): PreferenceValueMap[K] {
  const definition = PREFERENCE_REGISTRY[key];
  const allowed: readonly string[] = definition.values;
  const value = allowed.find((candidate) => candidate === rawValue?.trim());
  return (value ?? definition.defaultValue) as PreferenceValueMap[K];
}

/** Every preference read through `read`, e.g. from cookies or `<html>`. */
export function parsePreferences(
  read: (key: PreferenceKey) => string | null | undefined,
): PreferenceValueMap {
  const values = { ...PREFERENCE_DEFAULTS };
  function assign<K extends PreferenceKey>(key: K) {
    values[key] = parsePreference(key, read(key));
  }
  for (const key of PREFERENCE_KEYS) assign(key);
  return values;
}

/** The `data-*` attributes `<html>` carries for these preferences. */
export function preferenceAttributes(
  values: PreferenceValueMap,
): Record<string, string> {
  return Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [
      PREFERENCE_REGISTRY[key].attribute,
      values[key],
    ]),
  );
}
