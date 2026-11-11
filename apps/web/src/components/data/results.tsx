"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { ClearAllButton, FilterLabel } from "./filter-chip";

/**
 * The panel around tabs, filters and the table. It is the `results`
 * container, so the table turns into phone cards under 720px of panel, not
 * of window.
 */
export function ResultsPanel({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label={label}
      className="@container/results mt-4 overflow-clip rounded-xl border border-border bg-card text-sm shadow-xs [animation-delay:120ms] motion-safe:animate-rise"
    >
      {children}
    </section>
  );
}

/**
 * Whether the chips must move under the tabs: they're forced to, or the
 * one-row toolbar overflows (it can't wrap while they share the row).
 */
export function shouldStack({
  forced,
  scrollWidth,
  clientWidth,
}: {
  forced: boolean;
  scrollWidth: number;
  clientWidth: number;
}): boolean {
  return forced || scrollWidth > clientWidth + 1;
}

/**
 * The toolbar's width with every item at full size. It is right-aligned,
 * so items that don't fit spill out to the left, where `scrollWidth`
 * can't see them: add up the visible items and the gaps instead.
 */
function neededWidth(bar: HTMLElement): number {
  const style = getComputedStyle(bar);
  const items = [...bar.children].filter(
    (item) => item instanceof HTMLElement && item.offsetParent !== null,
  );
  const gaps =
    (parseFloat(style.columnGap) || 0) * Math.max(0, items.length - 1);
  const padding =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  const content = items.reduce(
    (sum, item) => sum + item.getBoundingClientRect().width,
    0,
  );
  return Math.max(bar.scrollWidth, content + gaps + padding);
}

/**
 * Tabs on the left and filter chips on the right, on one row while they
 * fit. When the chips overflow (measured on every render and whenever the
 * panel resizes), they stack under the tabs with a "Filter" label.
 * `stacked` forces that, e.g. for a page with more than five filters.
 */
export function ResultsHead({
  tabs,
  chips,
  onClearAll,
  stacked = false,
  filtersLabel = "Filters",
}: {
  tabs: ReactNode;
  chips: ReactNode;
  /** Shows "Clear all" while any filter is set. */
  onClearAll?: () => void;
  stacked?: boolean;
  filtersLabel?: string;
}): JSX.Element {
  const headRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const fit = useCallback(() => {
    const head = headRef.current;
    const bar = barRef.current;
    if (!head || !bar || stacked) return;
    head.dataset.stacked = "false";
    head.dataset.stacked = String(
      shouldStack({
        forced: false,
        scrollWidth: neededWidth(bar),
        clientWidth: bar.clientWidth,
      }),
    );
  }, [stacked]);

  useLayoutEffect(() => fit());

  useEffect(() => {
    const panel = headRef.current?.parentElement;
    if (!panel || stacked) return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next === width) return;
      width = next;
      fit();
    });
    observer.observe(panel);
    void document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [fit, stacked]);

  return (
    <div
      ref={headRef}
      data-stacked={stacked ? "true" : undefined}
      className="group/head flex items-stretch gap-x-8 gap-y-2 border-b border-border pr-4 pl-3 data-[stacked=true]:flex-col data-[stacked=true]:gap-0 data-[stacked=true]:p-0"
    >
      {tabs}
      <div
        ref={barRef}
        role="group"
        aria-label={filtersLabel}
        className="flex min-w-0 flex-auto flex-nowrap items-center justify-end gap-2 py-3 max-[600px]:group-not-data-[stacked=true]/head:px-3 group-data-[stacked=true]/head:flex-wrap group-data-[stacked=true]/head:justify-start group-data-[stacked=true]/head:bg-muted/40 group-data-[stacked=true]/head:px-4"
      >
        <FilterLabel />
        {chips}
        {onClearAll ? <ClearAllButton onClick={onClearAll} /> : null}
      </div>
    </div>
  );
}

/**
 * The table, cards or a state, under the head. `refreshing` dims it while a
 * new filter loads; `busy` marks the first load for assistive tech.
 */
export function ResultsBody({
  id,
  busy = false,
  refreshing = false,
  children,
}: {
  id?: string;
  busy?: boolean;
  refreshing?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      id={id}
      aria-busy={busy || undefined}
      className={cn(
        "transition-opacity duration-200",
        refreshing && "opacity-50",
      )}
    >
      {children}
    </div>
  );
}

/** Small print under the table, e.g. "Showing 50 of 120". */
export function ResultsFoot({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
