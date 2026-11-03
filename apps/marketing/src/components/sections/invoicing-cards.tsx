"use client";

import type { AnimationItem } from "lottie-web";
import type { ComponentProps, JSX, ReactNode, Ref } from "react";
import { useRef, useState } from "react";

import type { AssetId } from "~/lib/assets";
import { ArrowIcon, ArrowLeftIcon, ArrowRightIcon } from "~/components/icons";
import { ArrowSwap } from "~/components/ui/arrow-swap";
import { ButtonLink } from "~/components/ui/button";
import { Lottie } from "~/components/ui/lottie";
import { QontoImage } from "~/components/ui/qonto-image";
import { lottieUrl } from "~/lib/asset-url";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

type CardMedia =
  | { kind: "image"; asset: AssetId; alt: string }
  | { kind: "lottie"; asset: AssetId };

interface InvoicingCard {
  title: string;
  body: string;
  href: string;
  media: CardMedia;
}

type LottieBehaviour = Pick<
  ComponentProps<typeof Lottie>,
  "mode" | "hoverRef" | "onReady"
>;

const HEADING = "Compliant invoicing, zero effort";
const CTA_HREF = "https://qonto.com/en/invoicing";

const CARDS: readonly InvoicingCard[] = [
  {
    title: "Get ready for e-invoicing",
    body: "As a Certified Approved Platform, Qonto includes fully compliant e-invoicing in all plans.\u00a0",
    href: "https://qonto.com/en/invoicing/",
    media: {
      kind: "image",
      asset: "35243",
      alt: "WEB  UI  Hero TopicHighlight Bento Headline Cards E Invoicing Compliant WbRvmp",
    },
  },
  {
    title: "Quotes & invoices, faster with AI",
    body: "Qonto AI drafts invoices & quotes, you review them. Track status and get paid faster with payment links.",
    href: "https://qonto.com/en/invoicing/",
    media: { kind: "lottie", asset: "40503" },
  },
  {
    title: "Supplier invoices, minus the admin",
    body: "AI imports supplier invoices and flags what to check. You review & pay in a click. Reconciliation is automated.",
    href: "https://qonto.com/en/invoicing/supplier-invoices",
    media: { kind: "lottie", asset: "40850" },
  },
];

const LAST_INDEX = CARDS.length - 1;
const IMAGE_SIZES = "(min-width: 1024px) 33vw, 100vw";
const MEDIA_CLASS_NAME =
  "pointer-events-none size-full overflow-hidden rounded-2xl object-cover md:rounded-3xl";

const HOVER_LIFT = -10;
const HOVER_LIFT_DURATION = 0.25;
const HOVER_ARROW_DURATION = 0.1;

/** Swiper defaults on qonto.com: 300ms slides, 5px threshold, short swipes under 300ms, 0.85 edge resistance. */
const SLIDE_DURATION = 0.3;
const ACTIVE_ARROW_DURATION = 0.3;
const SWIPE_THRESHOLD = 5;
const SHORT_SWIPE_MS = 300;
const EDGE_RESISTANCE = 0.85;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  startOffset: number;
  startTime: number;
  dragging: boolean;
}

function slideOffset(
  slides: readonly (HTMLElement | null)[],
  index: number,
): number {
  return -(slides[index]?.offsetLeft ?? 0);
}

function resist(x: number, min: number, max: number): number {
  if (x > max) return max + (x - max) ** EDGE_RESISTANCE;
  if (x < min) return min - (min - x) ** EDGE_RESISTANCE;
  return x;
}

function clampIndex(index: number): number {
  return Math.min(Math.max(index, 0), LAST_INDEX);
}

export function InvoicingCards(): JSX.Element {
  return (
    <section
      id="section-5"
      data-header-theme="light"
      className="overflow-x-clip bg-primary-white"
    >
      <div className="container-qonto py-48 md:py-64 lg:py-80">
        <div className="flex w-full flex-col justify-between gap-24 md:gap-32 lg:mb-56 lg:flex-row lg:items-end lg:gap-8">
          <h2>{HEADING}</h2>
          <div className="mb-8 hidden lg:flex">
            <DiscoverInvoicingButton />
          </div>
        </div>
        <div className="hidden pt-38 md:block lg:hidden">
          <DiscoverInvoicingButton />
        </div>
        <CardGrid />
        <CardCarousel />
      </div>
    </section>
  );
}

function DiscoverInvoicingButton(): JSX.Element {
  return (
    <div className="flex flex-wrap gap-16">
      <ButtonLink href={CTA_HREF} variant="secondary">
        Discover invoicing
      </ButtonLink>
    </div>
  );
}

function CardGrid(): JSX.Element {
  return (
    <div className="hidden grid-cols-12 items-stretch gap-32 lg:grid">
      {CARDS.map((card) => (
        <GridCard key={card.title} card={card} />
      ))}
    </div>
  );
}

function GridCard({ card }: { card: InvoicingCard }): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);

  useGSAP(
    (_context, contextSafe) => {
      const element = cardRef.current;
      const arrow = arrowRef.current;
      if (!element || !arrow || !contextSafe) return;

      const animate = contextSafe((hovered: boolean): void => {
        const timeScale = prefersReducedMotion() ? 0 : 1;
        gsap.to(element, {
          y: hovered ? HOVER_LIFT : 0,
          duration: HOVER_LIFT_DURATION * timeScale,
          ease: EASE.cssOut,
          overwrite: true,
        });
        gsap.to(arrow, {
          opacity: hovered ? 1 : 0,
          duration: HOVER_ARROW_DURATION * timeScale,
          ease: "none",
          overwrite: true,
        });
      });
      const enter = (): void => {
        animate(true);
      };
      const leave = (): void => {
        animate(false);
      };

      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      return () => {
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      };
    },
    { scope: cardRef },
  );

  return (
    <div
      ref={cardRef}
      className="relative col-span-4 flex w-full flex-col rounded-3xl will-change-transform"
    >
      <CardFrame
        media={card.media}
        lottie={{ mode: "hover", hoverRef: cardRef }}
        arrowRef={arrowRef}
        arrowHidden
        arrow={
          <ArrowSwap
            triggerRef={cardRef}
            direction="up-right"
            size={18}
            duration={0.25}
            enterDelay={0.15}
            className="overflow-visible"
          />
        }
      />
      <CardCopy card={card} />
      <CardLink card={card} />
    </div>
  );
}

function CardCarousel(): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const arrowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lottieRefs = useRef<(AnimationItem | null)[]>([]);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);

  useGSAP(
    (_context, contextSafe) => {
      const track = trackRef.current;
      if (!track || !contextSafe) return;

      const offset = (index: number): number =>
        slideOffset(slideRefs.current, index);
      const nearest = (x: number): number => {
        let best = 0;
        for (let index = 1; index <= LAST_INDEX; index += 1) {
          if (Math.abs(offset(index) - x) < Math.abs(offset(best) - x)) {
            best = index;
          }
        }
        return best;
      };

      let drag: DragState | null = null;
      let suppressClick = false;

      const settle = contextSafe((index: number): void => {
        gsap.to(track, {
          x: offset(index),
          duration: prefersReducedMotion() ? 0 : SLIDE_DURATION,
          ease: EASE.css,
          overwrite: true,
        });
      });

      const onPointerDown = (event: PointerEvent): void => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick = false;
        drag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          startOffset: Number(gsap.getProperty(track, "x")),
          startTime: event.timeStamp,
          dragging: false,
        };
      };

      const onPointerMove = contextSafe((event: PointerEvent): void => {
        if (drag?.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        if (!drag.dragging) {
          const dy = event.clientY - drag.startY;
          if (Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
            suppressClick = true;
            drag = null;
            return;
          }
          if (Math.abs(dx) < SWIPE_THRESHOLD) return;
          drag.dragging = true;
          track.setPointerCapture(event.pointerId);
        }
        drag.lastX = event.clientX;
        gsap.set(track, {
          x: resist(drag.startOffset + dx, offset(LAST_INDEX), offset(0)),
          overwrite: true,
        });
      });

      const onPointerEnd = (event: PointerEvent): void => {
        if (drag?.pointerId !== event.pointerId) return;
        const { dragging, startX, lastX, startTime } = drag;
        drag = null;
        if (!dragging) return;

        suppressClick = true;
        if (event.type === "pointercancel") {
          settle(activeRef.current);
          return;
        }
        const dx = lastX - startX;
        const current = activeRef.current;
        const isShortSwipe =
          event.timeStamp - startTime < SHORT_SWIPE_MS && dx !== 0;
        const target = clampIndex(
          isShortSwipe
            ? current + (dx < 0 ? 1 : -1)
            : nearest(Number(gsap.getProperty(track, "x"))),
        );
        if (target === current) settle(current);
        else setActive(target);
      };

      const onClickCapture = (event: MouseEvent): void => {
        if (!suppressClick) return;
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      };

      const onFocusIn = (event: FocusEvent): void => {
        const target = event.target;
        if (!(target instanceof Element) || !target.matches(":focus-visible")) {
          return;
        }
        const index = slideRefs.current.findIndex(
          (slide) => slide?.contains(target) ?? false,
        );
        if (index >= 0) setActive(index);
      };

      const onResize = contextSafe((): void => {
        gsap.set(track, { x: offset(activeRef.current), overwrite: true });
      });

      track.addEventListener("pointerdown", onPointerDown);
      track.addEventListener("pointermove", onPointerMove);
      track.addEventListener("pointerup", onPointerEnd);
      track.addEventListener("pointercancel", onPointerEnd);
      track.addEventListener("click", onClickCapture, true);
      track.addEventListener("focusin", onFocusIn);
      window.addEventListener("resize", onResize);
      return () => {
        track.removeEventListener("pointerdown", onPointerDown);
        track.removeEventListener("pointermove", onPointerMove);
        track.removeEventListener("pointerup", onPointerEnd);
        track.removeEventListener("pointercancel", onPointerEnd);
        track.removeEventListener("click", onClickCapture, true);
        track.removeEventListener("focusin", onFocusIn);
        window.removeEventListener("resize", onResize);
      };
    },
    { scope: trackRef },
  );

  useGSAP(
    () => {
      activeRef.current = active;
      const track = trackRef.current;
      if (!track) return;

      const reduced = prefersReducedMotion();
      gsap.to(track, {
        x: slideOffset(slideRefs.current, active),
        duration: reduced ? 0 : SLIDE_DURATION,
        ease: EASE.css,
        overwrite: true,
      });
      arrowRefs.current.forEach((arrow, index) => {
        if (!arrow) return;
        gsap.to(arrow, {
          opacity: index === active ? 1 : 0,
          duration: reduced ? 0 : ACTIVE_ARROW_DURATION,
          ease: EASE.qonto,
          overwrite: true,
        });
      });
      if (!reduced) lottieRefs.current[active]?.goToAndPlay(0, true);
    },
    { scope: trackRef, dependencies: [active] },
  );

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={HEADING}
      className="-mx-16 pt-38 md:-mx-32 lg:hidden"
    >
      <div className="relative pl-16">
        <div
          ref={trackRef}
          className="relative flex cursor-grab touch-pan-y select-none"
        >
          {CARDS.map((card, index) => (
            <div
              key={card.title}
              ref={(element) => {
                slideRefs.current[index] = element;
              }}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} / ${CARDS.length}`}
              className="relative mr-16 flex w-[calc(100%-32px)] shrink-0 flex-col md:rounded-3xl"
            >
              <CardFrame
                media={card.media}
                lottie={{
                  mode: "manual",
                  onReady: (animation) => {
                    lottieRefs.current[index] = animation;
                    if (
                      index === activeRef.current &&
                      !prefersReducedMotion()
                    ) {
                      animation.goToAndPlay(0, true);
                    }
                  },
                }}
                arrowRef={(element) => {
                  arrowRefs.current[index] = element;
                }}
                arrowHidden={index !== 0}
                arrow={
                  <ArrowIcon width={18} height={18} className="rotate-135" />
                }
              />
              <CardCopy card={card} />
              <CardLink card={card} />
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex max-w-1600 items-center justify-end gap-16 px-16 pt-24 md:px-32 md:pt-32">
        <CarouselButton
          direction="left"
          label="Previous slide"
          disabled={active === 0}
          onClick={() => {
            setActive((index) => clampIndex(index - 1));
          }}
        />
        <CarouselButton
          direction="right"
          label="Next slide"
          disabled={active === LAST_INDEX}
          onClick={() => {
            setActive((index) => clampIndex(index + 1));
          }}
        />
      </div>
    </div>
  );
}

interface CarouselButtonProps {
  direction: "left" | "right";
  label: string;
  disabled: boolean;
  onClick: () => void;
}

function CarouselButton({
  direction,
  label,
  disabled,
  onClick,
}: CarouselButtonProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const iconClassName = "size-24 text-primary-black";

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="group flex cursor-pointer items-center disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="relative flex size-48 items-center justify-center overflow-hidden rounded-full bg-grey-100 group-disabled:opacity-45">
        <ArrowSwap
          triggerRef={buttonRef}
          direction={direction}
          size={24}
          duration={0.3}
          className="overflow-visible"
        >
          {direction === "left" ? (
            <ArrowLeftIcon className={iconClassName} />
          ) : (
            <ArrowRightIcon className={iconClassName} />
          )}
        </ArrowSwap>
      </span>
    </button>
  );
}

interface CardFrameProps {
  media: CardMedia;
  lottie: LottieBehaviour;
  arrowRef: Ref<HTMLDivElement>;
  arrowHidden: boolean;
  arrow: ReactNode;
}

function CardFrame({
  media,
  lottie,
  arrowRef,
  arrowHidden,
  arrow,
}: CardFrameProps): JSX.Element {
  return (
    <div className="relative w-full">
      <div className="surface-container-gradient-subtle relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl md:rounded-3xl">
        {media.kind === "image" ? (
          <QontoImage
            asset={media.asset}
            alt={media.alt}
            sizes={IMAGE_SIZES}
            draggable={false}
            className={MEDIA_CLASS_NAME}
          />
        ) : (
          <Lottie
            src={lottieUrl(media.asset)}
            preserveAspectRatio="xMidYMid slice"
            className={MEDIA_CLASS_NAME}
            {...lottie}
          />
        )}
      </div>
      <div className="absolute top-16 right-16 z-20">
        <div
          ref={arrowRef}
          className={cn(
            "flex size-32 items-center justify-center overflow-hidden rounded-full bg-grey-100 text-primary-black",
            arrowHidden && "opacity-0",
          )}
        >
          {arrow}
        </div>
      </div>
    </div>
  );
}

function CardCopy({ card }: { card: InvoicingCard }): JSX.Element {
  return (
    <div className="relative z-20 mt-16 lg:pr-12">
      <div className="flex flex-col gap-8">
        <h3 className="h3-small break-words">{card.title}</h3>
        <p className="body-regular break-words text-grey-700">{card.body}</p>
      </div>
    </div>
  );
}

function CardLink({ card }: { card: InvoicingCard }): JSX.Element {
  return (
    <a
      href={card.href}
      aria-label={card.title}
      draggable={false}
      className="absolute inset-0 z-30 cursor-pointer rounded-2xl md:rounded-3xl"
    />
  );
}
