"use client";

import { useState } from "react";

import type { SectionTheme } from "~/types/content";
import { ScrollTrigger, useGSAP } from "./gsap";

/**
 * Sections declare `data-header-theme="dark" | "light"`. Qonto's header and
 * mobile CTA bar switch palette to match whichever section sits under a
 * horizontal probe line `offset` px from the top of the viewport.
 */
export function useSectionTheme(
  offset: number,
  initial: SectionTheme = "dark",
): SectionTheme {
  const [theme, setTheme] = useState<SectionTheme>(initial);

  useGSAP(
    () => {
      const sections = document.querySelectorAll<HTMLElement>(
        "[data-header-theme]",
      );
      sections.forEach((section) => {
        const sectionTheme: SectionTheme =
          section.dataset.headerTheme === "light" ? "light" : "dark";
        ScrollTrigger.create({
          trigger: section,
          start: `top ${offset}px`,
          end: `bottom ${offset}px`,
          onToggle: (self) => {
            if (self.isActive) setTheme(sectionTheme);
          },
          onRefresh: (self) => {
            if (self.isActive) setTheme(sectionTheme);
          },
        });
      });
    },
    { dependencies: [offset] },
  );

  return theme;
}
