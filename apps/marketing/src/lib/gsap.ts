"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger, CustomEase);

/**
 * Qonto's CSS timing functions, registered once so GSAP tweens can match the
 * original transitions exactly. Use the string names in `ease:`.
 */
export const EASE = {
  /** Tailwind `ease-in-out`: cubic-bezier(0.4, 0, 0.2, 1) */
  qonto: CustomEase.create("qonto", "0.4,0,0.2,1"),
  /** Tailwind `ease-out`: cubic-bezier(0, 0, 0.2, 1) */
  qontoOut: CustomEase.create("qontoOut", "0,0,0.2,1"),
  /** Tailwind `ease-in`: cubic-bezier(0.4, 0, 1, 1) */
  qontoIn: CustomEase.create("qontoIn", "0.4,0,1,1"),
  /** Arrow swap keyframes: cubic-bezier(0.4, 0, 0.6, 1) */
  arrow: CustomEase.create("arrow", "0.4,0,0.6,1"),
  /** CSS `ease`: cubic-bezier(0.25, 0.1, 0.25, 1) */
  css: CustomEase.create("cssEase", "0.25,0.1,0.25,1"),
  /** CSS `ease-out`: cubic-bezier(0, 0, 0.58, 1) */
  cssOut: CustomEase.create("cssEaseOut", "0,0,0.58,1"),
  /** CSS `ease-in-out`: cubic-bezier(0.42, 0, 0.58, 1) */
  cssInOut: CustomEase.create("cssEaseInOut", "0.42,0,0.58,1"),
} as const;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

export { gsap, ScrollTrigger, useGSAP };
