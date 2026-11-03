"use client";

import type { AnimationItem } from "lottie-web";
import type { JSX } from "react";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import type { AssetId } from "~/lib/assets";
import { ChevronDownIcon } from "~/components/icons";
import { ButtonLink } from "~/components/ui/button";
import { Lottie } from "~/components/ui/lottie";
import { lottieUrl, staticUrl } from "~/lib/asset-url";
import {
  EASE,
  gsap,
  prefersReducedMotion,
  ScrollTrigger,
  useGSAP,
} from "~/lib/gsap";
import { cn } from "~/lib/utils";

interface AiStep {
  title: string;
  body: string;
  lottie: AssetId;
  /** Seconds the progress bar takes to fill: the Lottie's frames at 60fps. */
  duration: number;
}

const STEPS: readonly AiStep[] = [
  {
    title: "Agents, inside Qonto",
    body: "Ask Agents directly inside Qonto, right within the workflows you already use.",
    lottie: "40500",
    duration: 540 / 60,
  },
  {
    title: "MCP, in your AI tools",
    body: "Connect Qonto MCP to the AI tools you already work with every day.",
    lottie: "40501",
    duration: 450 / 60,
  },
  {
    title: "Visibility & accountability",
    body: "AI drafts the work, you review & approve. All actions logged and traceable.",
    lottie: "40502",
    duration: 450 / 60,
  },
];

const CTA_HREF = "https://qonto.com/en/ai";
const CTA_LABEL = "Discover Qonto AI";
const GRADIENT_SRC = staticUrl(
  "wr_topic_highlight_advanced/ai_gradient_background.png",
);
const DESKTOP_QUERY = "(min-width: 1024px)";
const INACTIVE_STEP_OPACITY = 0.4;

function subscribeToDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

/**
 * `null` until hydrated. Lotties mount only for the layout that is actually
 * displayed, so the hidden variant never downloads or renders its animations.
 */
function useIsDesktop(): boolean | null {
  return useSyncExternalStore(
    subscribeToDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => null,
  );
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Qonto's "topic highlight" block. From 1024px three steps auto-advance, each
 * bar filling over its Lottie's length while that Lottie is scrubbed by the
 * same timeline; below 1024px it is a single-open accordion.
 */
export function QontoAi(): JSX.Element {
  const isDesktop = useIsDesktop();

  return (
    <section
      id="section-4"
      data-header-theme="light"
      className="bg-primary-white text-primary-black"
    >
      <div className="container-qonto">
        <AiStepsDesktop enabled={isDesktop === true} />
        <AiAccordion showMedia={isDesktop === false} />
      </div>
    </section>
  );
}

function AiHeading({ className }: { className?: string }): JSX.Element {
  return (
    <h2 className={cn("h2-small", className)}>
      Qonto AI.
      <span className="block">Your choice, your control.</span>
    </h2>
  );
}

function GradientBackdrop(): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- decorative static PNG stretched by its absolute box; next/image has nothing to add
    <img
      src={GRADIENT_SRC}
      alt=""
      width={2960}
      height={2960}
      loading="lazy"
      decoding="async"
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
    />
  );
}

function AiStepsDesktop({ enabled }: { enabled: boolean }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const animationsRef = useRef<(AnimationItem | undefined)[]>([]);
  const selectRef = useRef<((index: number) => void) | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useGSAP(
    (_context, contextSafe) => {
      const root = rootRef.current;
      if (!enabled || !root || !contextSafe) return;

      const steps = stepRefs.current.filter(isPresent);
      const bars = barRefs.current.filter(isPresent);
      const panels = panelRefs.current.filter(isPresent);

      if (prefersReducedMotion()) {
        const show = contextSafe((index: number): void => {
          setActiveIndex(index);
          gsap.set(steps, {
            opacity: (i: number) => (i === index ? 1 : INACTIVE_STEP_OPACITY),
          });
          gsap.set(panels, { opacity: (i: number) => (i === index ? 1 : 0) });
          gsap.set(bars, { scaleY: (i: number) => (i === index ? 1 : 0) });
        });
        selectRef.current = show;
        show(0);
        return () => {
          selectRef.current = null;
        };
      }

      // Built once and re-aimed on every step change, so the endless
      // auto-advance never piles new tweens into the context.
      const fadeSteps = steps.map((step) =>
        gsap.quickTo(step, "opacity", { duration: 0.5, ease: EASE.css }),
      );
      const fadePanels = panels.map((panel) =>
        gsap.quickTo(panel, "opacity", { duration: 0.5, ease: EASE.qonto }),
      );
      let activeFill: gsap.core.Tween | undefined;

      const trigger = ScrollTrigger.create({
        trigger: root,
        start: "top 80%",
        end: "bottom top",
        onToggle: (self) => {
          if (self.isActive) activeFill?.play();
          else activeFill?.pause();
        },
      });

      const showFrame = (index: number, ratio: number): void => {
        const animation = animationsRef.current[index];
        animation?.goToAndStop(
          ratio * Math.max(animation.totalFrames - 1, 0),
          true,
        );
      };

      const activate: (index: number) => void = contextSafe(
        (index: number): void => {
          setActiveIndex(index);
          fadeSteps.forEach((fade, i) => {
            fade(i === index ? 1 : INACTIVE_STEP_OPACITY);
          });
          fadePanels.forEach((fade, i) => {
            fade(i === index ? 1 : 0);
          });
          fills.forEach((fill, i) => {
            if (i !== index) fill.pause(0);
          });

          activeFill = fills[index];
          showFrame(index, 0);
          if (trigger.isActive) activeFill?.restart();
          else activeFill?.pause(0);
        },
      );

      // The bar's tween is the step's clock: it scrubs the Lottie so both stay
      // in sync through scroll pauses, then hands over to the next step.
      const fills = bars.map((bar, index) => {
        const fill: gsap.core.Tween = gsap.fromTo(
          bar,
          { scaleY: 0 },
          {
            scaleY: 1,
            duration: STEPS[index]?.duration ?? 0,
            ease: "none",
            paused: true,
            immediateRender: false,
            onUpdate: () => {
              showFrame(index, fill.progress());
            },
            onComplete: () => {
              activate((index + 1) % bars.length);
            },
          },
        );
        return fill;
      });

      selectRef.current = activate;
      activate(0);

      return () => {
        selectRef.current = null;
      };
    },
    { scope: rootRef, dependencies: [enabled], revertOnUpdate: true },
  );

  return (
    <div ref={rootRef} className="hidden lg:block">
      <div className="mx-auto grid grid-cols-12 gap-x-24 px-48 py-80">
        <div className="col-span-5 flex flex-col gap-48">
          <AiHeading />
          <div className="flex flex-col gap-8">
            {STEPS.map((step, index) => (
              <div
                key={step.lottie}
                ref={(element) => {
                  stepRefs.current[index] = element;
                }}
                className={cn(
                  "relative flex items-stretch",
                  index > 0 && "opacity-40",
                )}
              >
                <div className="flex w-2 shrink-0">
                  <div className="bg-grey-400 w-full overflow-hidden rounded-full">
                    <div
                      ref={(element) => {
                        barRefs.current[index] = element;
                      }}
                      className="bg-primary-black h-full w-full origin-top rounded-full"
                      style={{ transform: "scaleY(0)" }}
                    />
                  </div>
                </div>
                <div className="flex-1 rounded-r-xl px-40 py-32">
                  <h3 className="h3-small mb-8">
                    <button
                      type="button"
                      aria-current={index === activeIndex ? "true" : undefined}
                      onClick={() => {
                        selectRef.current?.(index);
                      }}
                      className="cursor-pointer text-left after:absolute after:inset-0"
                    >
                      {step.title}
                    </button>
                  </h3>
                  <p className="text-18 leading-24">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
          <div>
            <ButtonLink href={CTA_HREF} variant="secondary">
              {CTA_LABEL}
            </ButtonLink>
          </div>
        </div>
        <div className="col-span-6 col-start-7 flex items-center justify-center">
          <div className="relative size-740 shrink-0 overflow-hidden rounded-3xl">
            <GradientBackdrop />
            {STEPS.map((step, index) => (
              <div
                key={step.lottie}
                ref={(element) => {
                  panelRefs.current[index] = element;
                }}
                className={cn("absolute inset-0", index > 0 && "opacity-0")}
              >
                {enabled ? (
                  <Lottie
                    src={lottieUrl(step.lottie)}
                    mode="manual"
                    onReady={(animation) => {
                      animationsRef.current[index] = animation;
                    }}
                    className="relative h-full w-full"
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AiAccordion({ showMedia }: { showMedia: boolean }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const chevronRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const idPrefix = useId();

  useGSAP(
    () => {
      const reduceMotion = prefersReducedMotion();
      gsap.to(panelRefs.current.filter(isPresent), {
        height: (i: number) => (i === openIndex ? "auto" : "0px"),
        duration: reduceMotion ? 0 : 0.3,
        ease: EASE.cssOut,
        overwrite: true,
      });
      gsap.to(chevronRefs.current.filter(isPresent), {
        rotation: (i: number) => (i === openIndex ? 180 : 0),
        duration: reduceMotion ? 0 : 0.5,
        ease: EASE.qontoOut,
        overwrite: true,
      });
    },
    { scope: rootRef, dependencies: [openIndex] },
  );

  return (
    <div ref={rootRef} className="lg:hidden">
      <div className="mx-auto px-16 py-40 md:px-32">
        <AiHeading className="mb-24" />
        {STEPS.map((step, index) => {
          const panelId = `${idPrefix}-panel-${index}`;
          return (
            <div key={step.lottie}>
              <div className="relative py-16">
                <div className="flex items-center justify-between">
                  <h3 className="h3-small">
                    <button
                      type="button"
                      aria-expanded={index === openIndex}
                      aria-controls={panelId}
                      onClick={() => {
                        setOpenIndex((current) =>
                          current === index ? null : index,
                        );
                      }}
                      className="cursor-pointer text-left after:absolute after:inset-0"
                    >
                      {step.title}
                    </button>
                  </h3>
                  <span
                    ref={(element) => {
                      chevronRefs.current[index] = element;
                    }}
                    className="ml-16 flex size-16 shrink-0 items-center justify-center"
                    style={
                      index === 0 ? { transform: "rotate(180deg)" } : undefined
                    }
                  >
                    <ChevronDownIcon />
                  </span>
                </div>
                <p className="body-regular mt-16">{step.body}</p>
              </div>
              <div
                ref={(element) => {
                  panelRefs.current[index] = element;
                }}
                id={panelId}
                className={cn("[clip-path:inset(0_-16px)]", index > 0 && "h-0")}
              >
                <div className="-mx-16 flex justify-center py-16">
                  <div className="relative size-343 overflow-hidden rounded-2xl">
                    <GradientBackdrop />
                    {showMedia ? (
                      <Lottie
                        src={lottieUrl(step.lottie)}
                        mode="loop"
                        className="relative h-full w-full"
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div className="mt-32">
          <ButtonLink href={CTA_HREF} variant="secondary">
            {CTA_LABEL}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
