"use client";

import type { CSSProperties, JSX } from "react";
import { useRef } from "react";

import type { AssetId } from "~/lib/assets";
import { ArrowSwap } from "~/components/ui/arrow-swap";
import { QontoImage } from "~/components/ui/qonto-image";
import {
  EASE,
  gsap,
  prefersReducedMotion,
  REDUCED_MOTION_QUERY,
  useGSAP,
} from "~/lib/gsap";

const MOTION_ALLOWED_QUERY = "(prefers-reduced-motion: no-preference)";

const GRADIENT_ANGLE = "--gradient-angle";
/** Qonto's `@property --gradient-angle` initial value, shown when motion is reduced. */
const RESTING_ANGLE = "80deg";
const SPIN_DURATION = 3;
const PULSE_STEP = 0.15;

type GlowCardStyle = CSSProperties & Record<typeof GRADIENT_ANGLE, string>;

/**
 * Qonto's `.gradient-border-auto`: a solid fill clipped to the padding box
 * over a conic highlight clipped to the border box, so only the 1px
 * transparent border shows the rotating glow.
 */
const GLOW_CARD_STYLE: GlowCardStyle = {
  [GRADIENT_ANGLE]: "0deg",
  background: [
    "linear-gradient(rgb(26, 26, 26), rgb(26, 26, 26)) padding-box",
    `conic-gradient(from var(${GRADIENT_ANGLE}), rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.8) 8%, rgba(255, 255, 255, 0) 18%, rgba(255, 255, 255, 0) 100%) border-box rgb(26, 26, 26)`,
  ].join(", "),
};

interface Badge {
  asset: AssetId;
  alt: string;
  sizes: string;
  text: string;
}

const BADGES: readonly Badge[] = [
  {
    asset: "34547",
    alt: "Cybersecurity Generic",
    sizes: "80px",
    text: "Legally protected customer funds",
  },
  {
    asset: "33291",
    alt: "Founds Regulatory ACPR",
    sizes: "80px",
    text: "Regulated financial institution",
  },
  {
    asset: "34548",
    alt: "Cybersecurity RGPD ISO27001",
    sizes: "140px",
    text: "Top standards in IT security & data protection",
  },
];

/**
 * Qonto's `.btn-tertiary`: arrow swap on hover, `tertiary-click-pulse` on
 * press. The anchor stretches across its flex column exactly as on qonto.com.
 */
function LearnMoreLink(): JSX.Element {
  const linkRef = useRef<HTMLAnchorElement>(null);

  useGSAP(
    (_context, contextSafe) => {
      const link = linkRef.current;
      if (!link || !contextSafe) return;

      const pulse = contextSafe((): void => {
        if (prefersReducedMotion()) return;
        gsap.to(link, {
          keyframes: [
            { scale: 0.9, duration: PULSE_STEP, ease: EASE.arrow },
            { scale: 1, duration: PULSE_STEP, ease: EASE.arrow },
          ],
          overwrite: true,
        });
      });

      link.addEventListener("pointerdown", pulse);
      return () => {
        link.removeEventListener("pointerdown", pulse);
      };
    },
    { scope: linkRef },
  );

  return (
    <a
      ref={linkRef}
      href="https://qonto.com/en/trust"
      className="inline-flex items-center text-16 leading-26 md:text-18 md:leading-28"
    >
      <span className="relative">Learn more</span>
      <ArrowSwap
        triggerRef={linkRef}
        direction="up-right"
        size={18}
        duration={0.3}
        enterDelay={0.15}
        className="ml-4 text-primary-white"
      />
    </a>
  );
}

/**
 * The glow spins only while the card is on screen; with reduced motion it
 * rests at Qonto's initial angle.
 */
function ProtectionCard(): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const card = cardRef.current;
      if (!card) return;

      const media = gsap.matchMedia();
      media.add(MOTION_ALLOWED_QUERY, () => {
        gsap.to(card, {
          [GRADIENT_ANGLE]: "360deg",
          duration: SPIN_DURATION,
          ease: "none",
          repeat: -1,
          scrollTrigger: {
            trigger: card,
            start: "top bottom",
            end: "bottom top",
            toggleActions: "play pause resume pause",
          },
        });
      });
      media.add(REDUCED_MOTION_QUERY, () => {
        gsap.set(card, { [GRADIENT_ANGLE]: RESTING_ANGLE });
      });
    },
    { scope: cardRef },
  );

  return (
    <div
      ref={cardRef}
      style={GLOW_CARD_STYLE}
      className="col-span-full mt-24 rounded-2xl border border-transparent px-16 py-24 shadow-[0_0_20px_0_rgba(255,255,255,0.08)] md:mt-32 md:rounded-3xl md:px-24 md:py-32 lg:col-span-7 lg:mt-0 lg:p-48"
    >
      <div className="mt-24 flex flex-col lg:h-full justify-center gap-x-56 gap-y-32 md:mt-32 md:flex-row lg:mt-0 lg:justify-end">
        {BADGES.map((badge) => (
          <div
            key={badge.asset}
            className="flex flex-col items-center justify-center text-center md:items-start md:text-left"
          >
            <QontoImage
              asset={badge.asset}
              alt={badge.alt}
              sizes={badge.sizes}
              className="h-64 w-auto shrink-0 object-contain invert md:h-80"
            />
            <div className="mt-24 body-regular">
              <p>{badge.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Protection(): JSX.Element {
  return (
    <section
      id="section-protection"
      data-header-theme="dark"
      className="darkmode w-full bg-primary-black text-primary-white"
    >
      <div className="container-qonto grid grid-cols-6 gap-x-8 py-48 md:grid-cols-9 md:gap-x-16 md:py-64 lg:grid-cols-12 lg:gap-x-24 lg:py-80">
        <div className="col-span-full flex flex-col justify-center lg:col-span-5">
          <h2 className="mb-16 h2-small md:mb-12 lg:mb-24">
            First-class protection for your business.
          </h2>
          <LearnMoreLink />
        </div>
        <ProtectionCard />
      </div>
    </section>
  );
}
