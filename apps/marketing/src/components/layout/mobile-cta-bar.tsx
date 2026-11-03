"use client";

import type { JSX } from "react";
import { useRef, useState } from "react";

import type { SectionTheme } from "~/types/content";
import { ButtonLink } from "~/components/ui/button";
import {
  EASE,
  gsap,
  prefersReducedMotion,
  ScrollTrigger,
  useGSAP,
} from "~/lib/gsap";
import { cn } from "~/lib/utils";

const SIGNUP_HREF = "https://welcome.qonto.com/signup/select-country";
const BAR_HEIGHT = 72;
const REVEAL_SCROLL_Y = 200;
const TRANSITION_DURATION = 0.6;
const BACKGROUND: Record<SectionTheme, string> = {
  dark: "rgba(5, 5, 5, 0.7)",
  light: "rgba(255, 255, 255, 0.7)",
};

/**
 * Qonto's `<768` sticky "Open an account" bar. It slides up once the page is
 * scrolled past the hero, slides away when the footer's bottom block comes
 * into view, and takes the palette of whichever `data-header-theme` section
 * sits under its top edge (viewport bottom − 72px).
 */
export function MobileCtaBar(): JSX.Element {
  const barRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<SectionTheme>("dark");

  useGSAP(
    (_context, contextSafe) => {
      const bar = barRef.current;
      if (!bar || !contextSafe) return;

      const transitionDuration = (): number =>
        prefersReducedMotion() ? 0 : TRANSITION_DURATION;
      let isVisible = false;
      let currentTheme: SectionTheme = "dark";

      gsap.set(bar, {
        yPercent: 100,
        autoAlpha: 0,
        backgroundColor: BACKGROUND[currentTheme],
      });

      const setVisible = contextSafe((next: boolean): void => {
        if (next === isVisible) return;
        isVisible = next;
        gsap.to(bar, {
          yPercent: next ? 0 : 100,
          autoAlpha: next ? 1 : 0,
          duration: transitionDuration(),
          ease: EASE.qonto,
          overwrite: "auto",
        });
      });

      const applyTheme = contextSafe((next: SectionTheme): void => {
        if (next === currentTheme) return;
        currentTheme = next;
        setTheme(next);
        gsap.to(bar, {
          backgroundColor: BACKGROUND[next],
          duration: isVisible ? transitionDuration() : 0,
          ease: EASE.qonto,
          overwrite: "auto",
        });
      });

      const footerEnd = document.querySelector("footer > :last-child");
      const reveal = ScrollTrigger.create({
        start: REVEAL_SCROLL_Y,
        ...(footerEnd
          ? { endTrigger: footerEnd, end: "top bottom" }
          : { end: "max" }),
        onToggle: (self) => {
          setVisible(self.isActive);
        },
      });
      setVisible(reveal.isActive);

      document
        .querySelectorAll<HTMLElement>("[data-header-theme]")
        .forEach((section) => {
          const sectionTheme: SectionTheme =
            section.dataset.headerTheme === "light" ? "light" : "dark";
          ScrollTrigger.create({
            trigger: section,
            start: `top bottom-=${BAR_HEIGHT}`,
            end: `bottom bottom-=${BAR_HEIGHT}`,
            onToggle: (self) => {
              if (self.isActive) applyTheme(sectionTheme);
            },
            onRefresh: (self) => {
              if (self.isActive) applyTheme(sectionTheme);
            },
          });
        });
    },
    { scope: barRef },
  );

  return (
    <aside
      ref={barRef}
      className={cn(
        "invisible fixed inset-x-0 bottom-0 z-1000 bg-[rgba(5,5,5,0.7)] px-16 opacity-0 backdrop-blur-[5px] md:hidden",
        theme === "dark" && "darkmode",
      )}
    >
      <ButtonLink
        href={SIGNUP_HREF}
        variant="primary"
        className="my-12 block text-16 leading-24"
      >
        Open an account
      </ButtonLink>
    </aside>
  );
}
