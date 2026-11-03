"use client";

import type { JSX, ReactNode, RefObject } from "react";
import { useRef } from "react";

import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";
import { ArrowIcon } from "../icons";

type Direction = "up-right" | "right" | "left";

interface ArrowSwapProps {
  /** Element whose hover starts the swap (the card, link or button). */
  triggerRef: RefObject<HTMLElement | null>;
  direction?: Direction;
  /** Box size in px: 18 for links/cards, 24 for carousel arrows. */
  size?: number;
  /** Exit/enter duration in seconds (0.25 cards, 0.3 tertiary links and carousel arrows). */
  duration?: number;
  /** Delay before the incoming arrow starts, in seconds. */
  enterDelay?: number;
  /** Override the glyph (defaults to the Qonto stroke arrow). */
  children?: ReactNode;
  className?: string;
}

function offsets(direction: Direction, size: number): { x: number; y: number } {
  if (direction === "up-right") return { x: size, y: -size };
  if (direction === "right") return { x: 40, y: 0 };
  return { x: -40, y: 0 };
}

/**
 * Qonto's "arrow swap" micro-interaction: on hover the visible arrow leaves
 * along its direction while a twin slides in from the opposite side
 * (`arrow-exit` / `arrow-enter` keyframes, cubic-bezier(0.4, 0, 0.6, 1)).
 * Leaving the trigger snaps both arrows back, like removing the CSS class.
 */
export function ArrowSwap({
  triggerRef,
  direction = "up-right",
  size = 18,
  duration = 0.25,
  enterDelay = 0.15,
  children,
  className,
}: ArrowSwapProps): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLDivElement>(null);
  const secondary = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const trigger = triggerRef.current;
      if (!trigger || !primary.current || !secondary.current) return;
      const { x, y } = offsets(direction, size);
      gsap.set(primary.current, { x: 0, y: 0 });
      gsap.set(secondary.current, { x: -x, y: -y });
      if (prefersReducedMotion()) return;

      const timeline = gsap
        .timeline({ paused: true })
        .to(primary.current, { x, y, duration, ease: EASE.arrow }, 0)
        .to(
          secondary.current,
          { x: 0, y: 0, duration, ease: EASE.arrow },
          enterDelay,
        );

      const play = (): void => {
        timeline.restart();
      };
      const reset = (): void => {
        timeline.pause(0);
      };
      trigger.addEventListener("pointerenter", play);
      trigger.addEventListener("pointerleave", reset);
      return () => {
        trigger.removeEventListener("pointerenter", play);
        trigger.removeEventListener("pointerleave", reset);
      };
    },
    { scope: container, dependencies: [direction, size, duration, enterDelay] },
  );

  const glyph = children ?? (
    <ArrowIcon
      width={size}
      height={size}
      className={cn(direction === "up-right" && "rotate-135")}
    />
  );

  return (
    <div
      ref={container}
      aria-hidden="true"
      className={cn("relative shrink-0 overflow-hidden", className)}
      style={{ width: size, height: size }}
    >
      <div ref={primary} className="absolute top-0 left-0 flex size-full">
        {glyph}
      </div>
      <div ref={secondary} className="absolute top-0 left-0 flex size-full">
        {glyph}
      </div>
    </div>
  );
}
