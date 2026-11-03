"use client";

import type { JSX } from "react";
import { useRef, useState } from "react";

import type { AssetId } from "~/lib/assets";
import { ArrowLeftIcon, ArrowRightIcon } from "~/components/icons";
import { ArrowSwap } from "~/components/ui/arrow-swap";
import { ButtonLink } from "~/components/ui/button";
import { QontoImage } from "~/components/ui/qonto-image";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

interface Testimonial {
  photo: AssetId;
  logo: AssetId | null;
  quote: string;
  author: string;
}

const HEADING = "Our customers say it best";
const CTA_HREF = "https://qonto.com/fr/customers";

const TESTIMONIALS: readonly Testimonial[] = [
  {
    photo: "34488",
    logo: "25709",
    quote:
      "Qonto adapts as our team grows. No more time-consuming, low-value processes. Employee expense management becomes simple.",
    author: "Oksana Besnier, Financer Manager at Poiscaille",
  },
  {
    photo: "34756",
    logo: "34546",
    quote:
      "I needed to move fast when launching my business. Having a platform like Qonto - bringing all the essential services together in one place - was the best solution for me.",
    author: "Pierre-Louis Vouteau, Founder of Ooak Data",
  },
  {
    photo: "34489",
    logo: "34545",
    quote:
      "I'd recommend Qonto to everyone. In my view, it's the ideal financial management solution for all businesses, regardless of their size or needs.",
    author: "Pierre-Antoine Errard, Founder of Solarian",
  },
  {
    photo: "34566",
    logo: null,
    quote:
      "I'd recommend Qonto to any entrepreneur looking for more than a bank - a true partner for their projects. I can finally spend time on my sites instead of on the phone with my bank.",
    author: "André Schmitte, Founder of AS Projets",
  },
];

const INITIAL_INDEX = 2;
const LAST_INDEX = TESTIMONIALS.length - 1;
const PHOTO_SIZES = "(min-width: 1024px) 1249px, 100vw";

/** Swiper `slidesOffsetBefore`/`After`: the container's lg padding. */
const TRACK_INSET = 48;
const INACTIVE_SLIDE_OPACITY = 0.5;
const CONTENT_OFFSET_Y = 8;

const SLIDE_DURATION = 0.5;
const SLIDE_OPACITY_DURATION = 0.35;
const FADE_DURATION = 0.3;
const CONTENT_OUT_DURATION = 0.15;
const CONTENT_IN_DURATION = 0.35;
const CONTENT_IN_DELAY = 0.15;

const DRAG_START_THRESHOLD = 5;
const LONG_SWIPE_RATIO = 0.15;
const SHORT_SWIPE_MS = 300;
const EDGE_RESISTANCE = 0.85;

interface SwipeHandlers {
  onStart?: () => void;
  onMove: (dx: number) => void;
  onEnd: (dx: number, isShortSwipe: boolean) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  startTime: number;
  dragging: boolean;
}

/**
 * Horizontal pointer drag that leaves vertical scrolling to the browser
 * (paired with `touch-action: pan-y`). Returns the listener cleanup.
 */
function attachSwipe(
  element: HTMLElement,
  handlers: SwipeHandlers,
): () => void {
  let drag: DragState | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startTime: event.timeStamp,
      dragging: false,
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging) {
      const dy = event.clientY - drag.startY;
      if (Math.abs(dy) > DRAG_START_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      if (Math.abs(dx) < DRAG_START_THRESHOLD) return;
      drag.dragging = true;
      element.setPointerCapture(event.pointerId);
      handlers.onStart?.();
    }
    drag.lastX = event.clientX;
    handlers.onMove(dx);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return;
    const { dragging, startX, lastX, startTime } = drag;
    drag = null;
    if (!dragging) return;
    handlers.onEnd(
      lastX - startX,
      event.timeStamp - startTime < SHORT_SWIPE_MS,
    );
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
  };
}

/** Swiper's release rule: a quick flick or a drag past 15% of the slide. */
function swipeStep(dx: number, width: number, isShortSwipe: boolean): number {
  if (dx === 0) return 0;
  if (!isShortSwipe && Math.abs(dx) < width * LONG_SWIPE_RATIO) return 0;
  return dx < 0 ? 1 : -1;
}

function clampIndex(index: number): number {
  return Math.min(Math.max(index, 0), LAST_INDEX);
}

function resist(x: number, min: number, max: number): number {
  if (x > max) return max + (x - max) ** EDGE_RESISTANCE;
  if (x < min) return min - (min - x) ** EDGE_RESISTANCE;
  return x;
}

/**
 * Track `x` that puts the slide at the container's left padding, clamped so
 * the last slide never travels past the right padding (Swiper's max translate).
 */
function trackOffset(
  track: HTMLElement,
  slides: readonly (HTMLElement | null)[],
  index: number,
): number {
  const slide = slides[index];
  const last = slides[LAST_INDEX];
  if (!slide || !last) return 0;
  const end =
    track.clientWidth - TRACK_INSET - (last.offsetLeft + last.offsetWidth);
  return Math.max(TRACK_INSET - slide.offsetLeft, end);
}

/** Outgoing copy drops 8px and fades fast; the incoming copy rises after it. */
function revealContent(
  elements: readonly (HTMLElement | null)[],
  active: number,
  timeScale: number,
): void {
  elements.forEach((element, index) => {
    if (!element) return;
    gsap.to(
      element,
      index === active
        ? {
            opacity: 1,
            y: 0,
            duration: CONTENT_IN_DURATION * timeScale,
            delay: CONTENT_IN_DELAY * timeScale,
            ease: EASE.qontoOut,
            overwrite: true,
          }
        : {
            opacity: 0,
            y: CONTENT_OFFSET_Y,
            duration: CONTENT_OUT_DURATION * timeScale,
            ease: EASE.qontoIn,
            overwrite: true,
          },
    );
  });
}

function fadeSlides(
  slides: readonly (HTMLElement | null)[],
  active: number,
  timeScale: number,
): void {
  slides.forEach((slide, index) => {
    if (!slide) return;
    gsap.to(slide, {
      opacity: index === active ? 1 : 0,
      duration: FADE_DURATION * timeScale,
      ease: EASE.qonto,
      overwrite: true,
    });
  });
}

function Quote({
  text,
  className,
}: {
  text: string;
  className: string;
}): JSX.Element {
  return (
    <div className={className}>
      <span>“</span>
      {text}
      <span>”</span>
    </div>
  );
}

interface CarouselProps {
  active: number;
  onSelect: (index: number) => void;
}

/**
 * ≥1024px: full-bleed Swiper track. Slides are 1.15 per view with a 24px gap
 * (1249px at 1440), capped at 1249px; neighbours stay visible at 50%.
 */
function SlideCarousel({ active, onSelect }: CarouselProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const overlayRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeRef = useRef(active);

  useGSAP(
    (_context, contextSafe) => {
      const track = trackRef.current;
      if (!track || !contextSafe) return;

      const offset = (index: number): number =>
        trackOffset(track, slideRefs.current, index);
      let dragOrigin = 0;

      const detachSwipe = attachSwipe(track, {
        onStart: contextSafe((): void => {
          dragOrigin = Number(gsap.getProperty(track, "x"));
          gsap.killTweensOf(track);
        }),
        onMove: contextSafe((dx: number): void => {
          gsap.set(track, {
            x: resist(dragOrigin + dx, offset(LAST_INDEX), offset(0)),
          });
        }),
        onEnd: contextSafe((dx: number, isShortSwipe: boolean): void => {
          const current = activeRef.current;
          const width = slideRefs.current[current]?.offsetWidth ?? 0;
          const target = clampIndex(
            current + swipeStep(dx, width, isShortSwipe),
          );
          if (target !== current) {
            onSelect(target);
            return;
          }
          gsap.to(track, {
            x: offset(current),
            duration: prefersReducedMotion() ? 0 : SLIDE_DURATION,
            ease: EASE.css,
            overwrite: true,
          });
        }),
      });

      const onResize = contextSafe((): void => {
        gsap.set(track, { x: offset(activeRef.current), overwrite: true });
      });
      window.addEventListener("resize", onResize);

      return () => {
        detachSwipe();
        window.removeEventListener("resize", onResize);
      };
    },
    { scope: trackRef },
  );

  useGSAP(
    () => {
      const track = trackRef.current;
      if (!track) return;
      const timeScale =
        activeRef.current !== active && !prefersReducedMotion() ? 1 : 0;
      activeRef.current = active;

      gsap.to(track, {
        x: trackOffset(track, slideRefs.current, active),
        duration: SLIDE_DURATION * timeScale,
        ease: EASE.css,
        overwrite: true,
      });
      slideRefs.current.forEach((slide, index) => {
        if (!slide) return;
        gsap.to(slide, {
          opacity: index === active ? 1 : INACTIVE_SLIDE_OPACITY,
          duration: SLIDE_OPACITY_DURATION * timeScale,
          ease: EASE.qonto,
          overwrite: true,
        });
      });
      revealContent(overlayRefs.current, active, timeScale);
    },
    { scope: trackRef, dependencies: [active] },
  );

  return (
    <div className="hidden lg:block">
      <div className="relative left-1/2 -ml-[50vw] w-screen">
        <div className="mx-auto max-w-1600">
          <div
            ref={trackRef}
            className="relative flex cursor-grab touch-pan-y select-none active:cursor-grabbing"
          >
            {TESTIMONIALS.map((testimonial, index) => (
              <div
                key={testimonial.author}
                ref={(element) => {
                  slideRefs.current[index] = element;
                }}
                role="group"
                aria-roledescription="slide"
                aria-label={`${index + 1} / ${TESTIMONIALS.length}`}
                aria-hidden={index !== active}
                className={cn(
                  "relative mr-24 h-708 w-[calc((100%_-_3.6px)/1.15)] max-w-1249 shrink-0",
                  index !== INITIAL_INDEX && "opacity-50",
                )}
              >
                <div className="relative isolate h-full overflow-hidden rounded-3xl">
                  <QontoImage
                    asset={testimonial.photo}
                    alt=""
                    sizes={PHOTO_SIZES}
                    draggable={false}
                    className="absolute inset-0 size-full object-cover object-top"
                  />
                  <div className="pointer-events-none absolute inset-0">
                    <QontoImage
                      asset={testimonial.photo}
                      alt=""
                      sizes={PHOTO_SIZES}
                      draggable={false}
                      className="photo-blur-left-to-right absolute inset-0 size-full object-cover object-top"
                    />
                    <div className="scrim-dark-left-to-right absolute inset-0" />
                  </div>
                  <div
                    ref={(element) => {
                      overlayRefs.current[index] = element;
                    }}
                    className={cn(
                      "absolute inset-0 z-10",
                      index !== INITIAL_INDEX && "opacity-0",
                    )}
                  >
                    {testimonial.logo ? (
                      <div className="absolute top-24 left-24">
                        <QontoImage
                          asset={testimonial.logo}
                          alt=""
                          draggable={false}
                          className="h-40 w-auto object-contain brightness-0 invert"
                        />
                      </div>
                    ) : null}
                    <div className="absolute inset-x-0 bottom-0 p-32 pb-80 text-primary-white">
                      <div className="w-[574px] max-w-full">
                        <Quote
                          text={testimonial.quote}
                          className="lead mb-16"
                        />
                        <div className="body-regular">{testimonial.author}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** <1024px: Swiper fade effect (crossFade), slides stacked in one grid cell. */
function FadeCarousel({ active, onSelect }: CarouselProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const contentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeRef = useRef(active);

  useGSAP(
    (_context, contextSafe) => {
      const root = rootRef.current;
      if (!root || !contextSafe) return;

      return attachSwipe(root, {
        onMove: contextSafe((dx: number): void => {
          const current = activeRef.current;
          const neighbour = current + (dx < 0 ? 1 : -1);
          const hasNeighbour = neighbour >= 0 && neighbour <= LAST_INDEX;
          const progress = Math.min(Math.abs(dx) / root.offsetWidth, 1);
          slideRefs.current.forEach((slide, index) => {
            if (!slide) return;
            let opacity = 0;
            if (index === current) opacity = hasNeighbour ? 1 - progress : 1;
            else if (index === neighbour) opacity = progress;
            gsap.set(slide, { opacity, overwrite: true });
          });
        }),
        onEnd: contextSafe((dx: number, isShortSwipe: boolean): void => {
          const current = activeRef.current;
          const target = clampIndex(
            current + swipeStep(dx, root.offsetWidth, isShortSwipe),
          );
          if (target !== current) {
            onSelect(target);
            return;
          }
          fadeSlides(
            slideRefs.current,
            current,
            prefersReducedMotion() ? 0 : 1,
          );
        }),
      });
    },
    { scope: rootRef },
  );

  useGSAP(
    () => {
      const timeScale =
        activeRef.current !== active && !prefersReducedMotion() ? 1 : 0;
      activeRef.current = active;
      fadeSlides(slideRefs.current, active, timeScale);
      revealContent(contentRefs.current, active, timeScale);
    },
    { scope: rootRef, dependencies: [active] },
  );

  return (
    <div
      ref={rootRef}
      className="grid cursor-grab touch-pan-y select-none active:cursor-grabbing lg:hidden"
    >
      {TESTIMONIALS.map((testimonial, index) => (
        <div
          key={testimonial.author}
          ref={(element) => {
            slideRefs.current[index] = element;
          }}
          role="group"
          aria-roledescription="slide"
          aria-label={`${index + 1} / ${TESTIMONIALS.length}`}
          aria-hidden={index !== active}
          className={cn(
            "col-start-1 row-start-1",
            index !== INITIAL_INDEX && "opacity-0",
          )}
        >
          <div className="relative mb-32 h-318 md:h-396">
            <QontoImage
              asset={testimonial.photo}
              alt=""
              sizes={PHOTO_SIZES}
              draggable={false}
              className="size-full rounded-2xl object-cover object-top md:rounded-3xl"
            />
            <div className="pointer-events-none absolute inset-0 rounded-2xl bg-primary-black/20 md:rounded-3xl" />
            {testimonial.logo ? (
              <div className="absolute top-16 left-16 z-10 md:top-24 md:left-24">
                <QontoImage
                  asset={testimonial.logo}
                  alt=""
                  draggable={false}
                  className="h-30 w-auto object-contain brightness-0 invert"
                />
              </div>
            ) : null}
          </div>
          <div
            ref={(element) => {
              contentRefs.current[index] = element;
            }}
            className={cn(
              "flex flex-col gap-y-24",
              index !== INITIAL_INDEX && "opacity-0",
            )}
          >
            <Quote text={testimonial.quote} className="lead" />
            <div className="body-regular">{testimonial.author}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface NavButtonProps {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}

function NavButton({
  direction,
  disabled,
  onClick,
}: NavButtonProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const Icon = direction === "left" ? ArrowLeftIcon : ArrowRightIcon;

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={direction === "left" ? "Previous slide" : "Next slide"}
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="relative flex size-48 items-center justify-center overflow-hidden rounded-full bg-grey-700">
        <ArrowSwap
          triggerRef={buttonRef}
          direction={direction}
          size={24}
          duration={0.3}
          className="overflow-visible"
        >
          <Icon className="size-24 text-primary-white" />
        </ArrowSwap>
      </span>
    </button>
  );
}

/**
 * "Our customers say it best" (qonto.com `wr-showreel`): click/drag carousel,
 * no autoplay, not looped. One active index drives the desktop track and the
 * mobile fade slider; only the one matching the breakpoint is displayed.
 */
export function Testimonials(): JSX.Element {
  const [active, setActive] = useState(INITIAL_INDEX);

  return (
    <section
      id="section-9"
      data-header-theme="dark"
      className="darkmode overflow-x-clip bg-primary-black py-48 text-primary-white md:py-64 lg:py-80"
    >
      <div className="container-qonto">
        <div className="mb-32 flex flex-col justify-between gap-24 md:mb-40 md:gap-32 lg:mb-56 lg:flex-row lg:items-end lg:gap-8">
          <h2>{HEADING}</h2>
          <div className="flex shrink-0 lg:mb-8">
            <ButtonLink href={CTA_HREF} variant="secondary">
              Lire les témoignages
            </ButtonLink>
          </div>
        </div>

        <div role="region" aria-roledescription="carousel" aria-label={HEADING}>
          <SlideCarousel active={active} onSelect={setActive} />
          <FadeCarousel active={active} onSelect={setActive} />
          <div className="relative z-20 mt-32 flex items-center justify-end gap-16">
            <NavButton
              direction="left"
              disabled={active === 0}
              onClick={() => {
                setActive((index) => clampIndex(index - 1));
              }}
            />
            <NavButton
              direction="right"
              disabled={active === LAST_INDEX}
              onClick={() => {
                setActive((index) => clampIndex(index + 1));
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
