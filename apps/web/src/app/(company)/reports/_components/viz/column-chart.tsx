"use client";

import type { JSX, KeyboardEvent } from "react";
import { cn } from "cn";
import { useRef } from "react";

import type { TipContent } from "./chart-tip";
import {
  ChartTip,
  nextIndex,
  useChartHover,
  useElementWidth,
} from "./chart-tip";
import { columnPath, compact, niceScale } from "./scale";

/**
 * One series over months: the chosen month in coral, the rest gray. Thin
 * columns, 4px rounded tops, square at the baseline. Each column is its own
 * hover target; the arrow keys read them one by one.
 */
export function ColumnChart({
  labels,
  values,
  selected,
  height,
  axis,
  ariaLabel,
  tip,
}: {
  /** Under each column, e.g. "Oct". */
  labels: readonly string[];
  /** Whole shillings, lined up with `labels`. */
  values: readonly number[];
  /** The highlighted column; -1 for none. */
  selected: number;
  height: number | ((width: number) => number);
  /** Gridlines and a labelled y-axis; without it, one top gridline. */
  axis: boolean;
  ariaLabel: string;
  tip: (index: number) => TipContent;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const width = useElementWidth(host);
  const hover = useChartHover();
  const H = typeof height === "function" ? height(width) : height;

  const m = axis ? { t: 22, r: 4, b: 22, l: 40 } : { t: 18, r: 2, b: 20, l: 2 };
  const iw = Math.max(0, width - m.l - m.r);
  const ih = H - m.t - m.b;
  const { top, ticks } = niceScale(Math.max(0, ...values));
  const slot = labels.length ? iw / labels.length : 0;
  const barWidth = Math.min(24, Math.max(4, slot * 0.56));
  const y = (value: number) => m.t + ih - (value / top) * ih;
  const sparse = slot < 34;
  const centre = (index: number) => m.l + slot * index + slot / 2;

  function anchorFor(index: number) {
    const rect = host.current?.getBoundingClientRect();
    return {
      x: (rect?.left ?? 0) + centre(index),
      y: (rect?.top ?? 0) + y(values[index] ?? 0),
    };
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const current = hover.active ?? Math.max(0, selected);
    const next = nextIndex(event.key, current, labels.length);
    if (next === null) return;
    event.preventDefault();
    hover.show(next, anchorFor(next));
  }

  return (
    <div ref={host} className="relative" style={{ height: H }}>
      {width > 0 ? (
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${String(width)} ${String(H)}`}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            const index = Math.max(0, selected);
            hover.show(index, anchorFor(index));
          }}
          onBlur={hover.hide}
          className="block overflow-visible rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
        >
          {axis ? (
            ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={m.l}
                  x2={m.l + iw}
                  y1={y(tick)}
                  y2={y(tick)}
                  className={tick === 0 ? "stroke-gray-300" : "stroke-hairline"}
                />
                <text
                  x={m.l - 8}
                  y={y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-gray-500 text-[11px] tabular-nums"
                >
                  {tick === 0 ? "0" : compact(tick)}
                </text>
              </g>
            ))
          ) : (
            <>
              <line
                x1={m.l}
                x2={m.l + iw}
                y1={y(top)}
                y2={y(top)}
                className="stroke-hairline"
              />
              <line
                x1={m.l}
                x2={m.l + iw}
                y1={y(0)}
                y2={y(0)}
                className="stroke-gray-300"
              />
              <text
                x={m.l}
                y={y(top) - 6}
                className="fill-gray-500 text-[11px] tabular-nums"
              >
                {compact(top)}
              </text>
            </>
          )}
          {labels.map((label, index) => {
            const value = values[index] ?? 0;
            const isSelected = index === selected;
            const isActive = index === hover.active;
            const labelled =
              !sparse ||
              isSelected ||
              ((index === 0 || index === labels.length - 1) &&
                Math.abs(index - selected) > 1);
            return (
              <g key={`${label}-${String(index)}`}>
                {value > 0 ? (
                  <path
                    d={columnPath(
                      centre(index) - barWidth / 2,
                      y(value),
                      barWidth,
                      Math.max(1, y(0) - y(value)),
                    )}
                    className={cn(
                      "transition-[fill] duration-150",
                      isSelected
                        ? isActive
                          ? "fill-brand-600"
                          : "fill-brand-500"
                        : isActive
                          ? "fill-gray-400"
                          : "fill-gray-300",
                    )}
                  />
                ) : null}
                {labelled ? (
                  <text
                    x={centre(index)}
                    y={H - 4}
                    textAnchor="middle"
                    className={cn(
                      "text-[11px]",
                      isSelected
                        ? "fill-gray-900 font-(--w-ui)"
                        : "fill-gray-500",
                    )}
                  >
                    {label}
                  </text>
                ) : null}
                <rect
                  x={m.l + slot * index}
                  y={0}
                  width={slot}
                  height={H - m.b + 6}
                  fill="transparent"
                  onPointerMove={(event) =>
                    hover.show(index, { x: event.clientX, y: event.clientY })
                  }
                  onPointerLeave={hover.hide}
                />
              </g>
            );
          })}
          {axis && selected >= 0 && (values[selected] ?? 0) > 0 ? (
            <text
              x={centre(selected)}
              y={y(values[selected] ?? 0) - 6}
              textAnchor="middle"
              className="pointer-events-none fill-gray-900 text-xs font-(--w-ui) tabular-nums"
            >
              {compact(values[selected] ?? 0)}
            </text>
          ) : null}
        </svg>
      ) : (
        <div role="img" aria-label={ariaLabel} />
      )}
      <ChartTip
        content={hover.active === null ? null : tip(hover.active)}
        anchor={hover.anchor}
      />
    </div>
  );
}
