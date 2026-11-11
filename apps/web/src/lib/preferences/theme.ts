export const THEME_MODE_OPTIONS = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
] as const;
export const THEME_MODE_VALUES = THEME_MODE_OPTIONS.map(
  (option) => option.value,
);
export type ThemeMode = (typeof THEME_MODE_VALUES)[number];
export type ResolvedThemeMode = "light" | "dark";

/**
 * "default" is the Expendi brand (coral, gray, Outfit) and always the
 * default; the others are opt-in looks from the shadcn admin template
 * (`src/styles/presets/`).
 */
export const THEME_PRESET_OPTIONS = [
  {
    label: "Expendi",
    value: "default",
    primary: { light: "#ff7e5f", dark: "#ff7e5f" },
  },
  {
    label: "Tangerine",
    value: "tangerine",
    primary: {
      light: "oklch(0.64 0.17 36.44)",
      dark: "oklch(0.64 0.17 36.44)",
    },
  },
  {
    label: "Soft Pop",
    value: "soft-pop",
    primary: {
      light: "oklch(0.5106 0.2301 276.9656)",
      dark: "oklch(0.6801 0.1583 276.9349)",
    },
  },
  {
    label: "Brutalist",
    value: "brutalist",
    primary: {
      light: "oklch(0.6489 0.237 26.9728)",
      dark: "oklch(0.7044 0.1872 23.1858)",
    },
  },
] as const;
export const THEME_PRESET_VALUES = THEME_PRESET_OPTIONS.map(
  (option) => option.value,
);
export type ThemePreset = (typeof THEME_PRESET_VALUES)[number];
