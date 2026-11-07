"use client";

import type { JSX, RefObject } from "react";
import { cn } from "cn";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** How a tooltip row keys its series: the mark it stands for. */
export type TipKey = "selected" | "context" | "line" | "dash" | "tick" | "none";

export interface TipRow {
  readonly key?: TipKey;
  readonly value: string;
  readonly label: string;
}

export interface TipContent {
  readonly head: string;
  readonly rows: readonly TipRow[];
  readonly foot?: string | null;
}

export interface TipAnchor {
  readonly x: number;
  readonly y: number;
}

const KEY_CLASSES: Record<TipKey, string> = {
  selected: "h-2.5 rounded-[2px] bg-brand-500",
  context: "h-2.5 rounded-[2px] bg-gray-300",
  line: "border-t-2 border-brand-700",
  dash: "border-t-2 border-dashed border-gray-500",
  tick: "mx-[5px] h-3 w-0.5! rounded-[1px] bg-gray-600",
  none: "",
};

/**
 * The charts' hover and focus readout: the value first, then what it is.
 * It only repeats what the chart's table view also shows.
 */
export function ChartTip({
  content,
  anchor,
}: {
  content: TipContent | null;
  anchor: TipAnchor | null;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip || !anchor) return;
    const { width, height } = tip.getBoundingClientRect();
    let left = anchor.x + 14;
    if (left + width > window.innerWidth - 8) left = anchor.x - width - 14;
    const top = Math.min(
      Math.max(8, anchor.y - height / 2),
      window.innerHeight - height - 8,
    );
    setPlace({ left: Math.max(8, left), top });
  }, [anchor, content]);

  if (!content || !anchor || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={
        place
          ? { left: place.left, top: place.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
      className="pointer-events-none fixed z-60 min-w-42 rounded-control border border-gray-200 bg-surface px-2.5 py-2 text-xs leading-4 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.22)]"
    >
      <div className="mb-1.5 text-gray-500">{content.head}</div>
      {content.rows.map((row) => (
        <div
          key={`${row.label}:${row.value}`}
          className="flex items-center gap-2 not-first-of-type:mt-1"
        >
          <span
            aria-hidden="true"
            className={cn("w-3 flex-none", KEY_CLASSES[row.key ?? "none"])}
          />
          <strong className="text-sm font-(--w-strong) text-gray-900 tabular-nums">
            {row.value}
          </strong>
          <span className="text-gray-500">{row.label}</span>
        </div>
      ))}
      {content.foot ? (
        <div className="mt-1.5 border-t border-hairline pt-1.5 text-gray-600">
          {content.foot}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export interface ChartHover {
  readonly active: number | null;
  readonly anchor: TipAnchor | null;
  show: (index: number, anchor: TipAnchor) => void;
  hide: () => void;
}

/** Which mark is under the pointer or keyboard focus, and where to put its tooltip. */
export function useChartHover(): ChartHover {
  const [state, setState] = useState<{
    active: number | null;
    anchor: TipAnchor | null;
  }>({ active: null, anchor: null });
  const show = useCallback((index: number, anchor: TipAnchor) => {
    setState({ active: index, anchor });
  }, []);
  const hide = useCallback(() => {
    setState({ active: null, anchor: null });
  }, []);
  return { ...state, show, hide };
}

/** The element's width, kept current as it resizes; 0 until measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Arrow keys, Home and End move through `count` marks from `current`. */
export function nextIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  const moves: Partial<Record<string, number>> = {
    ArrowLeft: current - 1,
    ArrowRight: current + 1,
    Home: 0,
    End: count - 1,
  };
  const next = moves[key];
  return next === undefined ? null : Math.min(count - 1, Math.max(0, next));
}
