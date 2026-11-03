"use client";

import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import type { Country } from "~/types/content";
import { CaretDownIcon, EuropeFlag } from "~/components/icons";
import { COUNTRIES } from "~/content/navigation";
import { EASE, gsap, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";
import { motionDuration } from "./constants";

const CURRENT_HREF = "/en";
const REGIONS: readonly Country[] = [
  { label: "Europe", href: CURRENT_HREF, flag: EuropeFlag },
  ...COUNTRIES,
];
const SPLIT = Math.ceil(REGIONS.length / 2);
const REGION_COLUMNS = [REGIONS.slice(0, SPLIT), REGIONS.slice(SPLIT)];

interface LanguageSwitchProps {
  /** `desktop` opens on hover under the 80px bar; `mobile` toggles on tap inside the drawer. */
  variant: "desktop" | "mobile";
}

export function LanguageSwitch({ variant }: LanguageSwitchProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const pointerType = useRef("");
  const panelId = useId();
  const isDesktop = variant === "desktop";

  useGSAP(
    () => {
      const caret = caretRef.current;
      if (!caret) return;
      gsap.to(caret, {
        rotation: open ? 180 : 0,
        duration: motionDuration(0.4),
        ease: EASE.cssOut,
        overwrite: true,
      });
    },
    { scope: containerRef, dependencies: [open] },
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const hoverTo =
    (next: boolean) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (isDesktop && event.pointerType === "mouse") setOpen(next);
    };

  const handleClick = (): void => {
    const openedByHover = isDesktop && pointerType.current === "mouse";
    pointerType.current = "";
    setOpen(openedByHover || !open);
  };

  return (
    <div
      ref={containerRef}
      onPointerEnter={hoverTo(true)}
      onPointerLeave={hoverTo(false)}
      className={
        isDesktop
          ? "relative flex h-80 items-center"
          : "flex flex-col items-start"
      }
    >
      <button
        type="button"
        aria-label="Change language"
        aria-expanded={open}
        aria-controls={panelId}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        onClick={handleClick}
        className={cn(
          "flex cursor-pointer items-center justify-center gap-8",
          isDesktop ? "px-10" : "mt-8",
        )}
      >
        <EuropeFlag className="size-16 rounded-full" />
        <span className="text-16 leading-26 uppercase">en</span>
        <span ref={caretRef} className="flex">
          <CaretDownIcon />
        </span>
      </button>
      <div
        id={panelId}
        className={cn(
          isDesktop ? "absolute top-full left-0 z-10 pt-16" : "pt-8",
          open ? "block" : "hidden",
        )}
      >
        <div className="bg-primary-white text-primary-black w-324 rounded-2xl p-16 shadow-[0_4px_24px_rgba(0,0,0,0.08)]">
          <p className="mb-8 text-18 leading-28 font-bold">
            Select your country
          </p>
          <p className="mb-16 text-14 leading-22">
            Explore our country-specific features in your preferred language.
          </p>
          <div className="flex">
            {REGION_COLUMNS.map((column) => (
              <ul key={column[0]?.label} className="w-1/2">
                {column.map(({ label, href, flag: Flag }) => (
                  <li key={label} className="mb-8 last:mb-0">
                    <a
                      href={href}
                      aria-current={href === CURRENT_HREF ? "page" : undefined}
                      className="flex w-fit items-center gap-8 py-2 text-16 leading-26"
                    >
                      <Flag className="size-16 flex-none rounded-full" />
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
