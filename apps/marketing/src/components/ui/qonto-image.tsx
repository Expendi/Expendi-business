import type { ImgHTMLAttributes, JSX } from "react";

import type { AssetId } from "~/lib/assets";
import { assetSize, assetSrcSet, assetUrl } from "~/lib/asset-url";

interface QontoImageProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "srcSet"
> {
  asset: AssetId;
  alt: string;
  /** Responsive `sizes`; defaults to Qonto's `(max-width: 2683px) 100vw, 2683px`. */
  sizes?: string;
  priority?: boolean;
}

/**
 * Plain `<img>` with the mirrored AVIF srcset. `next/image` is not used because
 * every source is a pre-sized static AVIF and `images.unoptimized` is on.
 */
export function QontoImage({
  asset,
  alt,
  sizes = "(max-width: 2683px) 100vw, 2683px",
  priority = false,
  ...rest
}: QontoImageProps): JSX.Element {
  const { width, height } = assetSize(asset);
  const srcSet = assetSrcSet(asset);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static pre-sized AVIF set, see component docs
    <img
      src={assetUrl(asset)}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      width={width}
      height={height}
      alt={alt}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      {...rest}
    />
  );
}
