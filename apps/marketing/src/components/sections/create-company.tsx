import type { JSX } from "react";

import type { FeatureItem } from "./feature-items";
import { ButtonLink } from "~/components/ui/button";
import { QontoImage } from "~/components/ui/qonto-image";
import { FeatureItems } from "./feature-items";

const CREATION_URL = "https://qonto.com/en/creation";

const COMPANY_ITEMS: readonly FeatureItem[] = [
  {
    title: "Simple and fast",
    description:
      "Ditch the paperwork. We'll have you up and running in 24 hours.",
    media: { kind: "tile", asset: "24698", alt: "WEB Iconography Black Fast" },
  },
  {
    title: "The right fit for your business",
    description:
      "Qonto works for all business structures: SAS, SASU, SARL, EURL, SCI, and micro-enterprises.",
    media: {
      kind: "tile",
      asset: "34341",
      alt: "WEB Iconography Black Target",
    },
  },
  {
    title: "We're with you all the way",
    description:
      "From start to KBIS, we're with you - and available every day to help.",
    media: {
      kind: "tile",
      asset: "26586",
      alt: "WEB Iconography Black Customer Service",
    },
  },
];

export function CreateCompany(): JSX.Element {
  return (
    <>
      <section
        id="section-7"
        data-header-theme="light"
        className="overflow-x-clip bg-primary-white text-primary-black"
      >
        <div className="container-qonto py-40 text-16 md:py-64 md:text-18 lg:py-80">
          <div className="mb-40 flex justify-between gap-x-48 lg:mb-56">
            <h2>Create your company with Qonto</h2>
            <div className="hidden shrink-0 self-end lg:block">
              <ButtonLink href={CREATION_URL} variant="secondary">
                Create your company
              </ButtonLink>
            </div>
          </div>
          <FeatureItems items={COMPANY_ITEMS} theme="light" />
          <div className="inline-block pt-40 md:block lg:hidden">
            <ButtonLink href={CREATION_URL} variant="secondary">
              Create your company
            </ButtonLink>
          </div>
        </div>
      </section>
      <section
        id="section-8"
        data-header-theme="light"
        className="hidden bg-primary-white pt-24 pb-80 md:block"
      >
        <div className="container-qonto">
          <div className="relative aspect-8/3 max-h-504 w-full overflow-hidden rounded-2xl lg:rounded-3xl">
            <QontoImage
              asset="33897"
              alt="Company Creation Upload Document Homepage"
              className="absolute inset-0 size-full object-cover object-center"
            />
          </div>
        </div>
      </section>
    </>
  );
}
