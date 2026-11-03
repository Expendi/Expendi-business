"use client";

import type { JSX } from "react";
import { useRef } from "react";

import type { NavHighlight } from "~/types/content";
import { ArrowSwap } from "~/components/ui/arrow-swap";
import { QontoImage } from "~/components/ui/qonto-image";
import { ASSETS } from "~/lib/assets";
import { cn } from "~/lib/utils";

interface MenuHighlightProps {
  highlight: NavHighlight;
}

/**
 * Highlight card closing a mega menu (desktop column) or a drawer category.
 * Transparent PNG cut-outs sit bottom-aligned at their natural square ratio on
 * the gradient, photos cover the frame, as on qonto.com.
 */
export function MenuHighlight({ highlight }: MenuHighlightProps): JSX.Element {
  const cardRef = useRef<HTMLAnchorElement>(null);
  const isCutout = ASSETS[highlight.image].file?.ext === "png";

  return (
    <>
      <a
        ref={cardRef}
        href={highlight.href}
        className="group surface-container-gradient-subtle relative mt-32 mb-16 block rounded-lg lg:mt-0 lg:max-h-335 lg:min-h-284 lg:flex-1"
      >
        <div
          className={cn(
            "w-full overflow-hidden rounded-lg md:h-310 lg:h-full lg:min-w-260",
            isCutout && "flex items-end",
          )}
        >
          <QontoImage
            asset={highlight.image}
            alt={highlight.title}
            sizes="(min-width: 1024px) 273px, 100vw"
            className={
              isCutout
                ? "aspect-[10/7] w-full rounded-lg object-contain lg:aspect-auto lg:object-cover"
                : "aspect-[10/7] h-full w-full rounded-lg object-cover object-center"
            }
          />
        </div>
        <div className="bg-grey-100 text-primary-black absolute top-16 right-16 flex size-32 items-center justify-center rounded-full">
          <ArrowSwap triggerRef={cardRef} />
        </div>
      </a>
      <div className="body-regular md:body-bold">
        <strong>{highlight.title}</strong>
      </div>
      <div className="body-regular md:body-small-regular">
        {highlight.description}
      </div>
    </>
  );
}
