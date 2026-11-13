/** The fonts Settings > Appearance offers; Outfit is the brand font and the default. */
export const FONT_OPTIONS = [
  { label: "Outfit", value: "outfit" },
  { label: "Geist", value: "geist" },
  { label: "Inter", value: "inter" },
  { label: "System", value: "system" },
] as const;
export const FONT_VALUES = FONT_OPTIONS.map((option) => option.value);
export type FontKey = (typeof FONT_VALUES)[number];
