"use client";

import type { AnimationItem } from "lottie-web";
import type { JSX } from "react";
import { useRef, useState } from "react";

import { Lottie } from "~/components/ui/lottie";
import { lottieUrl } from "~/lib/asset-url";
import {
  EASE,
  gsap,
  prefersReducedMotion,
  ScrollTrigger,
  useGSAP,
} from "~/lib/gsap";

/** Qonto's `data-lottie-min/max-frame-value`: frames 0–70 are a one-off intro. */
const INTRO_END_FRAME = 70;
const LAST_FRAME = 600;
const INTRO_SEGMENT: [number, number] = [0, LAST_FRAME];
const LOOP_SEGMENT: [number, number] = [INTRO_END_FRAME, LAST_FRAME];
const FADE_DURATION = 0.5;

export function Integrations(): JSX.Element {
  const section = useRef<HTMLElement>(null);
  const orbit = useRef<HTMLDivElement>(null);
  const animationRef = useRef<AnimationItem | null>(null);
  const [ready, setReady] = useState(false);

  useGSAP(
    () => {
      const trigger = section.current;
      const box = orbit.current;
      const animation = animationRef.current;
      if (!ready || !animation || !trigger || !box) return;

      const reduceMotion = prefersReducedMotion();
      gsap.to(box, {
        opacity: 1,
        duration: reduceMotion ? 0 : FADE_DURATION,
        ease: EASE.qonto,
      });
      if (reduceMotion) return;

      let introStarted = false;
      const play = (): void => {
        if (introStarted) {
          animation.play();
          return;
        }
        introStarted = true;
        animation.loop = false;
        animation.playSegments(INTRO_SEGMENT, true);
      };

      const removeCompleteListener = animation.addEventListener(
        "complete",
        () => {
          animation.loop = true;
          animation.playSegments(LOOP_SEGMENT, true);
        },
      );

      const scrollTrigger = ScrollTrigger.create({
        trigger,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => {
          if (self.isActive) play();
          else animation.pause();
        },
      });
      if (scrollTrigger.isActive) play();

      return removeCompleteListener;
    },
    { scope: section, dependencies: [ready] },
  );

  return (
    <section
      ref={section}
      id="section-6"
      data-header-theme="light"
      className="relative overflow-hidden bg-primary-white"
    >
      <div className="absolute inset-0 surface-container-gradient-subtle" />
      <div className="container-qonto grid grid-cols-6 py-48 md:grid-cols-9 md:gap-x-16 md:py-64 lg:grid-cols-12 lg:gap-x-24 lg:py-80">
        <div className="col-span-6 flex min-h-624 flex-col items-center overflow-hidden px-24 pt-32 text-center md:col-span-7 md:col-start-2 md:min-h-792 md:pt-48 lg:col-span-12 lg:col-start-1 lg:grid lg:min-h-504 lg:grid-cols-12 lg:content-center lg:gap-x-24 lg:overflow-visible lg:p-0 lg:text-left">
          <div className="z-10 grid grid-cols-6 lg:col-span-6 lg:py-64 lg:pl-64">
            <h2 className="col-span-6">Keep all your tools connected</h2>
            <div className="col-span-6 mt-12 mb-80 body-regular md:mt-16 lg:col-span-5 lg:mb-48">
              <p>
                Connect over 2,000 external tools &amp; accounts directly to
                Qonto - let all your data sync automatically.
              </p>
            </div>
          </div>

          <div className="relative z-10 flex size-full lg:col-span-6 lg:col-start-7 lg:row-start-1">
            <div
              ref={orbit}
              className="absolute top-0 left-1/2 flex size-496 -translate-x-1/2 items-center justify-center opacity-0 md:size-624 lg:top-1/2 lg:left-0 lg:size-760 lg:translate-x-0 lg:-translate-y-1/2"
            >
              <Lottie
                src={lottieUrl("34192")}
                mode="manual"
                reducedMotionFrame={INTRO_END_FRAME}
                onReady={(animation) => {
                  animationRef.current = animation;
                  setReady(true);
                }}
                className="size-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
