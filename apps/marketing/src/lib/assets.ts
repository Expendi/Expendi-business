export interface AssetVariant {
  size: "xs" | "sm" | "md" | "lg" | "xl";
  w: number;
  h: number;
}

export interface AssetEntry {
  variants: readonly AssetVariant[];
  file: { ext: string; w?: number; h?: number } | null;
}

/** Every mirrored qonto.com image, keyed by its CMS asset id, with the intrinsic size of each AVIF variant in `public/qonto/asset/<id>/`. */
export const ASSETS = {
  "3564": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "24698": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "25709": { variants: [], file: { ext: "svg", w: 122, h: 40 } },
  "26498": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "26586": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "32776": { variants: [], file: { ext: "jpg", w: 1200, h: 649 } },
  "33263": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "33275": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "jpg", w: 2160, h: 2160 },
  },
  "33288": {
    variants: [
      { size: "xs", w: 320, h: 183 },
      { size: "sm", w: 672, h: 384 },
      { size: "md", w: 672, h: 384 },
      { size: "lg", w: 672, h: 384 },
      { size: "xl", w: 672, h: 384 },
    ],
    file: { ext: "png", w: 672, h: 384 },
  },
  "33290": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 384, h: 384 },
      { size: "md", w: 384, h: 384 },
      { size: "lg", w: 384, h: 384 },
      { size: "xl", w: 384, h: 384 },
    ],
    file: { ext: "png", w: 384, h: 384 },
  },
  "33291": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 384, h: 384 },
      { size: "md", w: 384, h: 384 },
      { size: "lg", w: 384, h: 384 },
      { size: "xl", w: 384, h: 384 },
    ],
    file: { ext: "png", w: 384, h: 384 },
  },
  "33292": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 384, h: 384 },
      { size: "md", w: 384, h: 384 },
      { size: "lg", w: 384, h: 384 },
      { size: "xl", w: 384, h: 384 },
    ],
    file: { ext: "png", w: 384, h: 384 },
  },
  "33297": {
    variants: [
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
    ],
    file: null,
  },
  "33298": { variants: [{ size: "xl", w: 2683, h: 1509 }], file: null },
  "33384": {
    variants: [
      { size: "xs", w: 320, h: 149 },
      { size: "sm", w: 823, h: 384 },
      { size: "md", w: 823, h: 384 },
      { size: "lg", w: 823, h: 384 },
      { size: "xl", w: 823, h: 384 },
    ],
    file: { ext: "png", w: 823, h: 384 },
  },
  "33449": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 1920, h: 1080 },
    ],
    file: { ext: "jpg", w: 1920, h: 1080 },
  },
  "33450": {
    variants: [
      { size: "xs", w: 320, h: 569 },
      { size: "sm", w: 720, h: 1280 },
      { size: "md", w: 720, h: 1280 },
      { size: "lg", w: 720, h: 1280 },
      { size: "xl", w: 720, h: 1280 },
    ],
    file: { ext: "jpg", w: 720, h: 1280 },
  },
  "33596": { variants: [], file: { ext: "svg", w: 96, h: 96 } },
  "33597": {
    variants: [
      { size: "xs", w: 320, h: 101 },
      { size: "sm", w: 920, h: 291 },
      { size: "md", w: 1216, h: 384 },
      { size: "lg", w: 1216, h: 384 },
      { size: "xl", w: 1216, h: 384 },
    ],
    file: { ext: "png", w: 1216, h: 384 },
  },
  "33598": { variants: [], file: { ext: "svg", w: 96, h: 96 } },
  "33599": { variants: [], file: { ext: "svg", w: 96, h: 96 } },
  "33600": { variants: [], file: { ext: "svg", w: 96, h: 96 } },
  "33601": {
    variants: [
      { size: "xs", w: 320, h: 96 },
      { size: "sm", w: 920, h: 275 },
      { size: "md", w: 1284, h: 384 },
      { size: "lg", w: 1284, h: 384 },
      { size: "xl", w: 1284, h: 384 },
    ],
    file: { ext: "png", w: 1284, h: 384 },
  },
  "33603": { variants: [], file: { ext: "svg", w: 96, h: 96 } },
  "33887": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "png", w: 2160, h: 2160 },
  },
  "33897": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 2683, h: 1509 },
    ],
    file: { ext: "jpg", w: 3840, h: 2160 },
  },
  "34192": { variants: [], file: { ext: "json" } },
  "34341": { variants: [], file: { ext: "svg", w: 32, h: 32 } },
  "34488": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 2683, h: 1509 },
    ],
    file: { ext: "jpg", w: 3840, h: 2160 },
  },
  "34489": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 2683, h: 1509 },
    ],
    file: { ext: "jpg", w: 3840, h: 2160 },
  },
  "34545": { variants: [], file: { ext: "svg", w: 168, h: 40 } },
  "34546": { variants: [], file: { ext: "svg", w: 180, h: 40 } },
  "34547": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 384, h: 384 },
      { size: "md", w: 384, h: 384 },
      { size: "lg", w: 384, h: 384 },
      { size: "xl", w: 384, h: 384 },
    ],
    file: { ext: "png", w: 384, h: 384 },
  },
  "34548": {
    variants: [
      { size: "xs", w: 320, h: 183 },
      { size: "sm", w: 672, h: 384 },
      { size: "md", w: 672, h: 384 },
      { size: "lg", w: 672, h: 384 },
      { size: "xl", w: 672, h: 384 },
    ],
    file: { ext: "png", w: 672, h: 384 },
  },
  "34566": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 2683, h: 1509 },
    ],
    file: { ext: "jpg", w: 3840, h: 2160 },
  },
  "34756": {
    variants: [
      { size: "xs", w: 320, h: 180 },
      { size: "sm", w: 920, h: 518 },
      { size: "md", w: 1366, h: 768 },
      { size: "lg", w: 1727, h: 971 },
      { size: "xl", w: 2683, h: 1509 },
    ],
    file: { ext: "jpg", w: 3840, h: 2160 },
  },
  "35028": {
    variants: [
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
    ],
    file: null,
  },
  "35029": { variants: [{ size: "xl", w: 2683, h: 1509 }], file: null },
  "35031": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "png", w: 2160, h: 2160 },
  },
  "35042": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "jpg", w: 2160, h: 2160 },
  },
  "35054": {
    variants: [
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: null,
  },
  "35243": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "png", w: 2160, h: 2160 },
  },
  "35257": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "jpg", w: 2160, h: 2160 },
  },
  "35272": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 384, h: 384 },
      { size: "md", w: 384, h: 384 },
      { size: "lg", w: 384, h: 384 },
      { size: "xl", w: 384, h: 384 },
    ],
    file: { ext: "png", w: 384, h: 384 },
  },
  "36901": {
    variants: [
      { size: "xs", w: 320, h: 320 },
      { size: "sm", w: 920, h: 920 },
      { size: "md", w: 1366, h: 1366 },
      { size: "lg", w: 1727, h: 1727 },
      { size: "xl", w: 2160, h: 2160 },
    ],
    file: { ext: "png", w: 2160, h: 2160 },
  },
  "38018": { variants: [], file: { ext: "json" } },
  "40500": { variants: [], file: { ext: "json" } },
  "40501": { variants: [], file: { ext: "json" } },
  "40502": { variants: [], file: { ext: "json" } },
  "40503": { variants: [], file: { ext: "json" } },
  "40850": { variants: [], file: { ext: "json" } },
} as const satisfies Record<string, AssetEntry>;

export type AssetId = keyof typeof ASSETS;
