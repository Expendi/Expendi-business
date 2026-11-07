"use client";

import type { JSX, KeyboardEvent } from "react";
import { cn } from "cn";
import { useRef } from "react";

export interface KindTab<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Left out while loading, so no count pill shows. */
  readonly count?: number;
  /** `error` tints the count red, e.g. payments that failed. */
  readonly tone?: "error";
}

const MOVES: Partial<Record<string, (at: number, last: number) => number>> = {
  ArrowRight: (at) => at + 1,
  ArrowLeft: (at) => at - 1,
  Home: () => 0,
  End: (_, last) => last,
};

function countClass(
  tab: KindTab<string>,
  selected: boolean,
  variant: "panel" | "page",
): string {
  if (tab.tone === "error") return "bg-error-50 text-error-700";
  if (variant === "page") return "bg-gray-100 text-gray-700";
  return selected ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600";
}

/**
 * Tabs that split a list by stage or kind, each with a count pill. Arrow
 * keys, Home and End move between them (roving tab index). `page` tabs sit
 * on the page above its panels (Approvals) instead of across a results
 * panel's top.
 */
export function KindTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  controls,
  variant = "panel",
}: {
  label: string;
  tabs: readonly KindTab<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The id of the panel the tabs filter. */
  controls?: string;
  variant?: "panel" | "page";
}): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    const move = MOVES[event.key];
    if (!move) return;
    const next = tabs[move(at, tabs.length - 1)];
    if (!next) return;
    event.preventDefault();
    buttons.current[tabs.indexOf(next)]?.focus();
    onChange(next.value);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex overflow-x-auto border-b border-gray-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "page"
          ? "gap-6"
          : "gap-1 px-3 group-not-data-[stacked=true]/head:flex-none group-not-data-[stacked=true]/head:border-b-0 group-not-data-[stacked=true]/head:px-0",
      )}
    >
      {tabs.map((tab, at) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(node) => {
              buttons.current[at] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={controls}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => onKeyDown(event, at)}
            className={cn(
              "relative inline-flex items-center gap-2 border-0 bg-transparent text-sm font-(--w-ui) whitespace-nowrap transition-colors duration-150",
              variant === "page"
                ? "h-10 px-0"
                : "h-12 px-2 group-not-data-[stacked=true]/head:h-auto group-not-data-[stacked=true]/head:min-h-14",
              selected
                ? cn(
                    "text-gray-900 after:absolute after:-bottom-px after:h-0.5 after:bg-gray-900",
                    variant === "page"
                      ? "after:inset-x-0 after:rounded-[1px]"
                      : "after:inset-x-2 after:rounded-[2px]",
                  )
                : "text-gray-600 hover:text-gray-900",
            )}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span
                className={cn(
                  "inline-flex h-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums transition-colors duration-150",
                  variant === "page" ? "min-w-5" : "min-w-[22px]",
                  countClass(tab, selected, variant),
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
