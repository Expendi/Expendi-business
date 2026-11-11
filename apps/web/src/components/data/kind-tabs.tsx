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

function countClass(tab: KindTab<string>, selected: boolean): string {
  if (tab.tone === "error") return "bg-error-50 text-error-700";
  return selected
    ? "bg-muted text-foreground"
    : "bg-background/70 text-muted-foreground";
}

/**
 * Tabs that split a list by stage or kind, each with a count pill, in the
 * template's segmented Tabs look. Arrow keys, Home and End move between them
 * (roving tab index). `page` tabs sit on the page above its panels
 * (Approvals) instead of in a results panel's head.
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
      className={cn(
        "flex max-w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "panel" &&
          "flex-none items-center p-3 group-not-data-[stacked=true]/head:px-0",
      )}
    >
      <div
        role="tablist"
        aria-label={label}
        className="inline-flex h-9 w-fit flex-none items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground"
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
              data-active={selected || undefined}
              onClick={() => onChange(tab.value)}
              onKeyDown={(event) => onKeyDown(event, at)}
              className={cn(
                "inline-flex h-full items-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150",
                selected
                  ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                  : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums transition-colors duration-150",
                    countClass(tab, selected),
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
