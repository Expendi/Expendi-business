import type { JSX } from "react";

import type { FeatureItem } from "./feature-items";
import { FeatureItems } from "./feature-items";

const TRUST_ITEMS: readonly FeatureItem[] = [
  {
    title: "Made in France",
    description: "Qonto is a French company headquartered in Paris.",
    media: {
      kind: "badge",
      asset: "35272",
      alt: "WEB Badge Flag France WbRvmp",
    },
  },
  {
    title: "750,000+ clients",
    description: "use Qonto daily to run their business.",
    media: { kind: "tile", asset: "3564", alt: "WEB Iconography Black Qonto" },
  },
  {
    title: "24/7 human support",
    description: "We're available via chat, email, and phone.",
    media: {
      kind: "badge",
      asset: "33384",
      alt: "Customer Support 24 7 DarkMode",
    },
  },
];

export function TrustItems(): JSX.Element {
  return (
    <section
      id="section-2"
      data-header-theme="dark"
      className="darkmode overflow-x-clip bg-primary-black text-primary-white"
    >
      <div className="container-qonto py-40 text-16 md:py-64 md:text-18 lg:py-80">
        {/* Qonto keeps the empty heading row and CTA slot of the shared block; their spacing sets this section's height. */}
        <div className="mb-40 lg:mb-56" />
        <FeatureItems items={TRUST_ITEMS} theme="dark" />
        <div className="inline-block pt-40 md:block lg:hidden" />
      </div>
    </section>
  );
}
