import type { JSX } from "react";

import type { AssetId } from "~/lib/assets";
import type { SectionTheme } from "~/types/content";
import { QontoImage } from "~/components/ui/qonto-image";
import { cn } from "~/lib/utils";

export interface FeatureItem {
  title: string;
  description: string;
  /** `tile` centres a 32px icon on a themed square; `badge` is a self-contained image shown at the tile height. */
  media: { kind: "tile" | "badge"; asset: AssetId; alt: string };
}

interface FeatureItemsProps {
  items: readonly FeatureItem[];
  theme: SectionTheme;
}

const THEME_CLASSES = {
  dark: {
    tile: "bg-grey-900",
    title: "text-primary-white",
    body: "text-grey-300",
  },
  light: {
    tile: "bg-grey-50",
    title: "text-primary-black",
    body: "text-grey-700",
  },
} as const satisfies Record<
  SectionTheme,
  { tile: string; title: string; body: string }
>;

/**
 * Qonto's `wr-items-section` grid: items stack below `lg`, then sit three
 * across with `subgrid` rows so icons, titles and copy stay aligned.
 */
export function FeatureItems({ items, theme }: FeatureItemsProps): JSX.Element {
  const classes = THEME_CLASSES[theme];
  return (
    <div className="grid grid-cols-6 gap-y-32 md:grid-cols-9 md:gap-x-16 md:gap-y-48 lg:grid-cols-12 lg:grid-rows-[auto_auto_auto] lg:gap-x-24 lg:gap-y-0">
      {items.map((item) => (
        <div
          key={item.title}
          className="col-span-full lg:col-span-4 lg:row-span-3 lg:grid lg:grid-rows-subgrid lg:pr-24"
        >
          <div className="flex h-full flex-col lg:contents">
            <div className="mb-12 flex md:mb-16">
              <FeatureMedia media={item.media} tileClassName={classes.tile} />
            </div>
            <div className="flex flex-1 flex-col gap-y-8 lg:contents">
              <h3 className={cn("h3-small lg:mb-8", classes.title)}>
                {item.title}
              </h3>
              <p className={cn("body-regular lg:grow", classes.body)}>
                {item.description}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FeatureMedia({
  media,
  tileClassName,
}: {
  media: FeatureItem["media"];
  tileClassName: string;
}): JSX.Element {
  if (media.kind === "badge") {
    return (
      <QontoImage
        asset={media.asset}
        alt={media.alt}
        className="h-40 w-auto rounded-lg md:h-48 lg:h-56"
      />
    );
  }
  return (
    <div
      className={cn(
        "flex size-40 items-center justify-center rounded-lg md:size-48 lg:size-56",
        tileClassName,
      )}
    >
      <QontoImage
        asset={media.asset}
        alt={media.alt}
        className="size-24 md:size-28 lg:size-32"
      />
    </div>
  );
}
