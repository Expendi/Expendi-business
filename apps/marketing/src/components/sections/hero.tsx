"use client";

import type { JSX } from "react";
import { useRef } from "react";

import { ButtonLink } from "~/components/ui/button";
import { QontoImage } from "~/components/ui/qonto-image";
import { staticUrl, VIDEO } from "~/lib/asset-url";
import { EASE, gsap, useGSAP } from "~/lib/gsap";

const DESKTOP_QUERY = "(min-width: 1024px)";
const MOTION_ALLOWED_QUERY = "(prefers-reduced-motion: no-preference)";

/**
 * Full-bleed homepage hero. The poster pictures sit under a looping video that
 * is sourced client-side per breakpoint and fades in once it actually plays;
 * with reduced motion the video is never loaded and the poster stays.
 */
export function Hero(): JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useGSAP(
    () => {
      const video = videoRef.current;
      if (!video) return;

      gsap
        .matchMedia()
        .add(
          { isDesktop: DESKTOP_QUERY, motionAllowed: MOTION_ALLOWED_QUERY },
          (context) => {
            if (!context.conditions?.motionAllowed) return;

            const fadeIn = gsap.to(video, {
              opacity: 1,
              duration: 0.5,
              ease: EASE.qonto,
              paused: true,
            });
            const reveal = (): void => {
              fadeIn.play();
            };
            video.addEventListener("playing", reveal, { once: true });
            video.src = context.conditions.isDesktop
              ? VIDEO.heroDesktop
              : VIDEO.heroMobile;

            return () => {
              video.removeEventListener("playing", reveal);
              video.pause();
            };
          },
        );
    },
    { scope: sectionRef },
  );

  return (
    <section
      ref={sectionRef}
      id="section-1"
      data-header-theme="dark"
      className="darkmode bg-primary-black text-primary-white relative min-h-svh w-full lg:min-h-screen"
    >
      <picture className="absolute inset-0 z-10 block h-svh w-full lg:hidden">
        <QontoImage
          asset="33450"
          alt="WEB Various HeroFullWidth Homepage Mobile Static WbRvmp"
          className="h-full w-full object-cover"
        />
      </picture>
      <picture className="absolute inset-0 z-10 hidden h-screen w-full lg:block">
        <QontoImage
          asset="33449"
          alt="WEB Various HeroFullWidth Homepage Desktop Static WbRvmp"
          className="h-full w-full object-cover"
          priority
        />
      </picture>
      <video
        ref={videoRef}
        id="hero-video"
        aria-hidden="true"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="absolute inset-0 z-20 h-svh w-full object-cover opacity-0 lg:h-screen"
      />
      <div className="scrim-dark-photo-overlay-gradient pointer-events-none absolute inset-0 z-30 h-svh lg:h-screen" />

      <div className="container-qonto relative z-40 grid grid-cols-6 gap-24 pt-88 pb-48 md:grid-cols-9 md:gap-y-32 md:pt-96 md:pb-72 lg:h-screen lg:max-h-1264 lg:grid-cols-12 lg:content-end lg:gap-y-48 lg:pt-128 lg:pb-48">
        <div className="col-span-6 flex min-h-[calc(100svh-88px)] flex-col justify-end pb-48 md:col-span-9 md:min-h-[calc(100svh-96px)] md:pb-72 lg:col-span-12 lg:min-h-0 lg:pb-0">
          <div className="flex flex-col gap-y-16 lg:w-870 lg:gap-y-24">
            <ul className="h-32 w-fit">
              <li className="text-14 leading-36">
                <a
                  href="https://trustpilot.com/review/qonto.com"
                  className="inline-flex items-center whitespace-nowrap"
                >
                  <span className="mr-4 font-bold">4.7</span>
                  <span>of 5</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size static SVG; next/image has nothing to optimise */}
                  <img
                    src={staticUrl("trustpilot-logo-with-text-dark.svg")}
                    alt="Trustpilot badge"
                    width={73}
                    height={22}
                    className="ml-8"
                  />
                </a>
              </li>
            </ul>
            <h1 className="text-28 leading-36 md:text-[52px] md:leading-62 lg:text-72 lg:leading-80">
              <span className="block">Business account.</span>
              <span className="block">Finance management.</span>
              <span className="block">Company creation.</span>
            </h1>
          </div>
          <div className="mt-48 flex flex-wrap gap-16 lg:mt-72">
            <ButtonLink
              href="https://welcome.qonto.com/signup/select-country"
              variant="primary"
            >
              Open an account
            </ButtonLink>
            <ButtonLink href="https://qonto.com/en/pricing" variant="secondary">
              Find the right plan
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
