"use client";

import type { JSX } from "react";
import { useRef } from "react";

import { EASE, gsap, useGSAP } from "~/lib/gsap";
import { motionDuration } from "./constants";

const BAR_OFFSET = 8;
const BAR = "absolute left-0 h-2 w-full bg-current";

interface HamburgerProps {
  open: boolean;
  controls: string;
  onToggle: () => void;
}

/** Three 2px bars that fold into an X: the middle one fades, the outer two meet and rotate. */
export function Hamburger({
  open,
  controls,
  onToggle,
}: HamburgerProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const topRef = useRef<HTMLSpanElement>(null);
  const middleRef = useRef<HTMLSpanElement>(null);
  const bottomRef = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const top = topRef.current;
      const middle = middleRef.current;
      const bottom = bottomRef.current;
      if (!top || !middle || !bottom) return;
      const tween = {
        duration: motionDuration(0.25),
        ease: EASE.qonto,
        overwrite: true,
      };
      gsap.to(top, {
        ...tween,
        y: open ? BAR_OFFSET : 0,
        rotation: open ? -45 : 0,
      });
      gsap.to(middle, { ...tween, opacity: open ? 0 : 1 });
      gsap.to(bottom, {
        ...tween,
        y: open ? -BAR_OFFSET : 0,
        rotation: open ? 45 : 0,
      });
    },
    { scope: buttonRef, dependencies: [open] },
  );

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="Expand main menu"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="relative h-64 w-27 cursor-pointer md:w-32 lg:hidden"
    >
      <span ref={topRef} className={`${BAR} top-23`} />
      <span ref={middleRef} className={`${BAR} top-31`} />
      <span ref={bottomRef} className={`${BAR} top-39`} />
    </button>
  );
}
