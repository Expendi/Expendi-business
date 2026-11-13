import { fileURLToPath } from "node:url";

/** What the invoice PDF and the payment receipt PDF share: fonts, brand and page. */

export const FONT_REGULAR = fileURLToPath(
  new URL("../../../assets/fonts/Outfit_400Regular.ttf", import.meta.url),
);
export const FONT_SEMIBOLD = fileURLToPath(
  new URL("../../../assets/fonts/Outfit_600SemiBold.ttf", import.meta.url),
);
/** The dashboard's brand mark (`apps/web/public/expendi-mark.png`). */
export const BRAND_MARK = fileURLToPath(
  new URL("../../../assets/brand/expendi-mark.png", import.meta.url),
);

/** `--color-brand-600` in apps/web's tokens. */
export const CORAL = "#f0613e";
/** `--color-success-700`, the dashboard's paid colour. */
export const PAID_GREEN = "#067647";
export const INK = "#101828";
export const MUTED = "#667085";
export const RULE = "#e4e7ec";

export const PAGE_MARGIN = 48;
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
export const BOTTOM = PAGE_HEIGHT - PAGE_MARGIN;

export interface RenderOptions {
  /** Called with every string drawn, so tests can assert on content. */
  readonly onText?: (text: string) => void;
  /** Off in tests, which read the stream's bytes. */
  readonly compress?: boolean;
}
