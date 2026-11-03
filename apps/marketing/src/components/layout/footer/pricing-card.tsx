"use client";

import type { JSX } from "react";
import { useRef } from "react";

import { ArrowSwap } from "~/components/ui/arrow-swap";

/** Dark "Pricing" tile; hovering anywhere on it swaps the up-right arrow. */
export function PricingCard(): JSX.Element {
  const card = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={card}
      className="rounded-2xl bg-grey-900 p-24 md:rounded-3xl lg:w-2/3"
    >
      <a
        href="https://qonto.com/en/pricing"
        className="flex w-full items-start justify-between gap-4"
      >
        <span>Pricing</span>
        <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-full bg-grey-700 text-primary-white">
          <ArrowSwap triggerRef={card} />
        </div>
      </a>
      <p className="caption pt-16 text-grey-300">
        Find the best plan for your business needs.
      </p>
    </div>
  );
}
