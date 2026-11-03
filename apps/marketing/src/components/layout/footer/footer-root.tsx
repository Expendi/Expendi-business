"use client";

import type { JSX, ReactNode } from "react";
import { useRef } from "react";

import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";

interface FooterRootProps {
  children: ReactNode;
  className?: string;
}

/**
 * `<footer>` landmark that drives Qonto's `border-bottom-animation` on every
 * `.footer-link-underline` inside it: the 1px line grows from the left on
 * hover and, because the anchor flips to the right on leave, retracts to the
 * right (`background-size` 0.2s ease-in-out).
 */
export function FooterRoot({
  children,
  className,
}: FooterRootProps): JSX.Element {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    (_context, contextSafe) => {
      const scope = root.current;
      if (!scope || !contextSafe) return;

      const draw = contextSafe((link: HTMLElement, visible: boolean): void => {
        gsap.set(link, {
          backgroundPosition: visible ? "0% 100%" : "100% 100%",
        });
        gsap.to(link, {
          backgroundSize: visible ? "100% 1px" : "0% 1px",
          duration: prefersReducedMotion() ? 0 : 0.2,
          ease: EASE.cssInOut,
          overwrite: true,
        });
      });

      const unbind = Array.from(
        scope.querySelectorAll<HTMLElement>(".footer-link-underline"),
        (link) => {
          const show = (): void => {
            draw(link, true);
          };
          const hide = (): void => {
            draw(link, false);
          };
          link.addEventListener("pointerenter", show);
          link.addEventListener("pointerleave", hide);
          return (): void => {
            link.removeEventListener("pointerenter", show);
            link.removeEventListener("pointerleave", hide);
          };
        },
      );

      return () => {
        unbind.forEach((remove) => {
          remove();
        });
      };
    },
    { scope: root },
  );

  return (
    <footer ref={root} className={className}>
      {children}
    </footer>
  );
}
