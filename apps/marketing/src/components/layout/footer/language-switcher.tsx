"use client";

import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";

import type { Country } from "~/types/content";
import { CaretDownIcon, EuropeFlag } from "~/components/icons";
import { COUNTRIES } from "~/content/navigation";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";

interface LanguageSwitcherProps {
  /** Horizontal anchor of the country panel, which opens above the button. */
  align: "end" | "center";
  className?: string;
}

/**
 * Footer `lang-switch-container`: opens on mouse hover, toggles on tap or
 * keyboard, closes on outside press or Escape. The caret flips 180° (0.4s
 * ease-out) while the panel is open.
 */
export function LanguageSwitcher({
  align,
  className,
}: LanguageSwitcherProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useGSAP(
    () => {
      if (!caret.current) return;
      gsap.to(caret.current, {
        rotation: open ? 180 : 0,
        duration: prefersReducedMotion() ? 0 : 0.4,
        ease: EASE.cssOut,
        overwrite: true,
      });
    },
    { scope: root, dependencies: [open] },
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target))
        return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className={cn("relative flex cursor-pointer items-center", className)}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className="mx-auto flex cursor-pointer items-center justify-center gap-8"
        onClick={(event) => {
          const { nativeEvent } = event;
          const viaMouse =
            nativeEvent instanceof PointerEvent &&
            nativeEvent.pointerType === "mouse";
          setOpen((value) => viaMouse || !value);
        }}
      >
        <EuropeFlag className="mr-4 size-16 rounded-full" />
        <span className="sr-only">Change language, current:</span>
        <span className="font-light uppercase">en</span>
        {/* Qonto inverts the caret from lg, leaving it white on the white footer. */}
        <span ref={caret} className="ml-4 flex lg:text-primary-white">
          <CaretDownIcon />
        </span>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className={cn(
          "absolute bottom-full z-20 w-340 cursor-auto rounded-2xl bg-primary-white p-24 text-left text-primary-black shadow-[0_4px_24px_rgba(0,0,0,0.08)]",
          align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
        )}
      >
        <p className="mb-8 text-18 leading-28 font-bold">Select your country</p>
        <p className="mb-16 text-14 leading-22">
          Explore our country-specific features in your preferred language.
        </p>
        <div className="flex">
          <CountryList countries={COUNTRIES.slice(0, 4)} withCurrentRegion />
          <CountryList countries={COUNTRIES.slice(4)} />
        </div>
      </div>
    </div>
  );
}

const COUNTRY_ROW = "flex items-center gap-8 text-16 leading-28";

interface CountryListProps {
  countries: readonly Country[];
  /** Prepends the active "Europe" entry (the current `/en` site). */
  withCurrentRegion?: boolean;
}

function CountryList({
  countries,
  withCurrentRegion = false,
}: CountryListProps): JSX.Element {
  return (
    <ul className="w-1/2">
      {withCurrentRegion && (
        <li aria-current="true" className={cn("mb-8", COUNTRY_ROW)}>
          <EuropeFlag className="size-16 shrink-0 rounded-full" />
          Europe
        </li>
      )}
      {countries.map(({ label, href, flag: Flag }) => (
        <li key={label} className="mb-8">
          <a href={href} className={COUNTRY_ROW}>
            <Flag className="size-16 shrink-0 rounded-full" />
            {label}
          </a>
        </li>
      ))}
    </ul>
  );
}
