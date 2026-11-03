"use client";

import type { AnimationItem } from "lottie-web";
import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  prefersReducedMotion,
  REDUCED_MOTION_QUERY,
  ScrollTrigger,
  useGSAP,
} from "~/lib/gsap";
import { cn } from "~/lib/utils";

/**
 * How playback starts:
 * - `loop`: plays on loop while on screen (lottie-player `autoplay loop`).
 * - `inview-once`: plays once the first time it scrolls into view, then holds the last frame.
 * - `hover`: frame 0 until `hoverRef` is hovered, then plays once and holds (`onHoverCut`).
 * - `manual`: never plays by itself; drive it through `onReady`.
 */
export type LottieMode = "loop" | "inview-once" | "hover" | "manual";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

interface LottieProps {
  src: string;
  mode: LottieMode;
  hoverRef?: RefObject<HTMLElement | null>;
  /** Restrict looping to a frame range, like Qonto's `data-lottie-min/max-frame-value`. */
  segment?: [number, number];
  /** Frame shown when the user prefers reduced motion. Defaults to the last frame. */
  reducedMotionFrame?: number;
  preserveAspectRatio?: string;
  onReady?: (animation: AnimationItem) => void;
  className?: string;
}

/**
 * Renders a Qonto Lottie JSON with lottie-web (SVG renderer). The library is
 * imported lazily because it touches `document` at module scope. Viewport
 * gating uses GSAP ScrollTrigger so off-screen animations stay paused.
 */
export function Lottie({
  src,
  mode,
  hoverRef,
  segment,
  reducedMotionFrame,
  preserveAspectRatio = "xMidYMid meet",
  onReady,
  className,
}: LottieProps): JSX.Element {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    prefersReducedMotion,
    () => false,
  );
  const container = useRef<HTMLDivElement>(null);
  const [animation, setAnimation] = useState<AnimationItem | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  const segmentStart = segment?.[0];
  const segmentEnd = segment?.[1];

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    let instance: AnimationItem | null = null;

    void import("lottie-web/build/player/lottie_svg")
      .then(({ default: lottie }) => {
        if (cancelled) return;
        instance = lottie.loadAnimation({
          container: element,
          renderer: "svg",
          loop: mode === "loop",
          autoplay: false,
          path: src,
          rendererSettings: { preserveAspectRatio, progressiveLoad: true },
        });
        instance.addEventListener("DOMLoaded", () => {
          if (!instance || cancelled) return;
          if (prefersReducedMotion()) {
            instance.goToAndStop(
              reducedMotionFrame ?? Math.max(instance.totalFrames - 1, 0),
              true,
            );
          } else {
            instance.goToAndStop(segmentStart ?? 0, true);
          }
          setAnimation(instance);
          onReadyRef.current?.(instance);
        });
      })
      .catch((error: unknown) => {
        console.error(`Failed to load Lottie ${src}`, error);
      });

    return () => {
      cancelled = true;
      instance?.destroy();
      setAnimation(null);
    };
  }, [src, mode, preserveAspectRatio, reducedMotionFrame, segmentStart]);

  useGSAP(
    () => {
      const element = container.current;
      if (!animation || !element) return;
      if (reducedMotion) {
        animation.goToAndStop(
          reducedMotionFrame ?? Math.max(animation.totalFrames - 1, 0),
          true,
        );
        return;
      }

      if (mode === "loop") {
        const play = (): void => {
          if (segmentStart !== undefined && segmentEnd !== undefined) {
            animation.playSegments([segmentStart, segmentEnd], true);
          } else {
            animation.play();
          }
        };
        const trigger = ScrollTrigger.create({
          trigger: element,
          start: "top bottom",
          end: "bottom top",
          onToggle: (self) => {
            if (self.isActive) play();
            else animation.pause();
          },
        });
        if (trigger.isActive) play();
        return () => animation.pause();
      }

      if (mode === "inview-once") {
        ScrollTrigger.create({
          trigger: element,
          start: "top 85%",
          once: true,
          onEnter: () => {
            animation.loop = false;
            animation.goToAndPlay(0, true);
          },
        });
        return () => animation.pause();
      }

      if (mode === "hover") {
        const target = hoverRef?.current;
        if (!target) return;
        const play = (): void => {
          animation.loop = false;
          animation.setDirection(1);
          animation.goToAndPlay(0, true);
        };
        target.addEventListener("pointerenter", play);
        return () => {
          target.removeEventListener("pointerenter", play);
          animation.pause();
        };
      }
    },
    {
      scope: container,
      dependencies: [
        animation,
        mode,
        segmentStart,
        segmentEnd,
        hoverRef,
        reducedMotion,
        reducedMotionFrame,
      ],
      revertOnUpdate: true,
    },
  );

  return (
    <div
      ref={container}
      aria-hidden="true"
      className={cn("[&>svg]:block", className)}
    />
  );
}
