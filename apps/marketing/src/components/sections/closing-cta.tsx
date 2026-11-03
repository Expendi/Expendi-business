import type { JSX } from "react";

import { ButtonLink } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const PHOTO_LAYER = "pointer-events-none absolute inset-0 bg-cover bg-center";

const CTA_PHOTO =
  "bg-[url(/qonto/asset/35028/md.avif)] md:bg-[url(/qonto/asset/35028/lg.avif)] lg:bg-[url(/qonto/asset/35029/xl.avif)]";

/**
 * Full-bleed photo CTA. The header reads it as a light section (Qonto's
 * `surface-section-background-base`), but the copy sits on a dark scrim, so
 * the buttons take their `darkmode` palette from a local wrapper. Below 768px
 * the primary button is dropped in favour of the sticky mobile CTA bar.
 */
export function ClosingCta(): JSX.Element {
  return (
    <section
      id="section-11"
      data-header-theme="light"
      className="relative isolate overflow-hidden bg-primary-white"
    >
      <div className={cn(PHOTO_LAYER, CTA_PHOTO)} />
      <div
        className={cn(
          PHOTO_LAYER,
          CTA_PHOTO,
          "photo-blur-top-to-bottom lg:photo-blur-left-to-right",
        )}
      />
      <div className="pointer-events-none absolute inset-0 scrim-dark-top-to-bottom lg:scrim-dark-left-to-right" />

      <div className="relative container-qonto grid grid-cols-6 gap-x-8 py-48 md:grid-cols-9 md:gap-x-16 md:py-64 lg:grid-cols-12 lg:gap-x-24 lg:py-80">
        <div className="col-span-6 flex flex-col items-center px-24 pt-32 pb-460 text-center text-primary-white md:col-span-7 md:col-start-2 md:pt-48 lg:col-span-12 lg:col-start-1 lg:grid lg:min-h-504 lg:grid-cols-12 lg:content-center lg:gap-x-24 lg:px-0 lg:py-64 lg:text-left">
          <h2 className="lg:col-span-6 lg:pl-64">
            Complicated?
            <span className="block">Not with Qonto.</span>
          </h2>
          <div className="mt-12 body-regular md:mt-16 lg:col-span-5 lg:col-start-1 lg:pl-64">
            <p>Open your business account in just 10 minutes.</p>
          </div>
          <div className="mt-32 flex flex-col items-center gap-16 lg:col-span-5 lg:col-start-1 lg:mt-48 lg:flex-row lg:pl-64">
            <div className="darkmode flex flex-wrap justify-center gap-16 lg:justify-start">
              <ButtonLink
                href="https://welcome.qonto.com/signup/select-country"
                variant="primary"
                className="max-md:hidden"
              >
                Open an account
              </ButtonLink>
              <ButtonLink
                href="https://qonto.com/en/pricing"
                variant="secondary"
              >
                Find the right plan
              </ButtonLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
