import type { AssetEntry, AssetId, AssetVariant } from "./assets";
import { ASSETS } from "./assets";

type VariantSize = AssetVariant["size"];

/** `/qonto/asset/<id>/<size>.avif`, or the original file when `size` is omitted. */
export function assetUrl(id: AssetId, size?: VariantSize): string {
  const entry = ASSETS[id];
  if (size) return `/qonto/asset/${id}/${size}.avif`;
  const largest = entry.variants.at(-1);
  if (largest) return `/qonto/asset/${id}/${largest.size}.avif`;
  if (entry.file) return `/qonto/asset/${id}/file.${entry.file.ext}`;
  throw new Error(`Asset ${id} has no downloadable file`);
}

/** AVIF `srcset` with the real intrinsic width of every mirrored variant. */
export function assetSrcSet(id: AssetId): string | undefined {
  const variants: readonly AssetVariant[] = ASSETS[id].variants;
  if (variants.length === 0) return undefined;
  const seen = new Set<number>();
  return variants
    .filter((variant) => {
      if (seen.has(variant.w)) return false;
      seen.add(variant.w);
      return true;
    })
    .map((variant) => `/qonto/asset/${id}/${variant.size}.avif ${variant.w}w`)
    .join(", ");
}

/** Intrinsic size of the largest variant, for `width`/`height` attributes. */
export function assetSize(id: AssetId): { width: number; height: number } {
  const entry = ASSETS[id];
  const largest = entry.variants.at(-1);
  if (largest) return { width: largest.w, height: largest.h };
  const file: AssetEntry["file"] = entry.file;
  if (file?.w && file.h) return { width: file.w, height: file.h };
  return { width: 32, height: 32 };
}

/** Files Qonto serves from `/blog/assets/` (fonts, favicons, chatbot avatar…). */
export function staticUrl(path: string): string {
  return `/qonto/static/${path}`;
}

export function lottieUrl(id: AssetId): string {
  return `/qonto/asset/${id}/file.json`;
}

export const VIDEO = {
  heroDesktop: "/qonto/video/web-en-various-16x9-homepage-desktop.mp4",
  heroMobile: "/qonto/video/down-net-http20260612-55-7yckw-lg-original.mp4",
} as const;
