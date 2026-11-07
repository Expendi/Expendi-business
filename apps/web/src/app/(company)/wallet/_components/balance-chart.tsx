"use client";

import type { JSX, KeyboardEvent } from "react";
import { useId, useRef } from "react";

import type { DailyBalance } from "./wallet-display";
import type { TipContent } from "~/app/(company)/reports/_components/viz/chart-tip";
import {
  ChartTip,
  nextIndex,
  useChartHover,
  useElementWidth,
} from "~/app/(company)/reports/_components/viz/chart-tip";
import {
  compact,
  niceScale,
} from "~/app/(company)/reports/_components/viz/scale";
import { dayMonth } from "./wallet-display";

const HEIGHT = 180;
const MARGIN = { t: 10, r: 56, b: 24, l: 36 };

/** USDC base units as whole USDC, only for placing the line. */
function usdcValue(units: string): number {
  return Number(BigInt(units) / 10_000n) / 100;
}

/**
 * The balance at the end of each day: a step line, because the balance
 * only moves when money does. A crosshair reads any day; on focus the
 * arrow keys, Home and End do.
 */
export function BalanceChart({
  series,
  ariaLabel,
  tip,
}: {
  series: readonly DailyBalance[];
  ariaLabel: string;
  tip: (point: DailyBalance) => TipContent;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const width = useElementWidth(host);
  const hover = useChartHover();
  const fillId = useId();

  const values = series.map((point) => usdcValue(point.units));
  const count = values.length;
  const iw = Math.max(0, width - MARGIN.l - MARGIN.r);
  const ih = HEIGHT - MARGIN.t - MARGIN.b;
  const { top, ticks } = niceScale(Math.max(0, ...values));
  const x = (index: number) =>
    MARGIN.l + (count > 1 ? (index / (count - 1)) * iw : iw / 2);
  const y = (value: number) => MARGIN.t + ih - (Math.max(0, value) / top) * ih;

  let line = "";
  values.forEach((value, index) => {
    line +=
      index === 0
        ? `M${x(0).toFixed(1)} ${y(value).toFixed(1)}`
        : ` H${x(index).toFixed(1)} V${y(value).toFixed(1)}`;
  });
  const area = `${line} V${y(0).toFixed(1)} H${x(0).toFixed(1)} Z`;
  const last = count - 1;
  const end = values[last] ?? 0;

  function anchorFor(index: number) {
    const rect = host.current?.getBoundingClientRect();
    return {
      x: (rect?.left ?? 0) + x(index),
      y: (rect?.top ?? 0) + MARGIN.t + ih / 2,
    };
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const next = nextIndex(event.key, hover.active ?? last, count);
    if (next === null) return;
    event.preventDefault();
    hover.show(next, anchorFor(next));
  }

  const active = hover.active;
  const activePoint = active === null ? undefined : series[active];

  return (
    <div ref={host} className="relative mt-2" style={{ height: HEIGHT }}>
      {width > 0 && count > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => hover.show(last, anchorFor(last))}
          onBlur={hover.hide}
          className="block overflow-visible rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-brand-500)"
                stopOpacity={0.16}
              />
              <stop
                offset="100%"
                stopColor="var(--color-brand-500)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.l}
                x2={MARGIN.l + iw}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? "stroke-gray-300" : "stroke-hairline"}
              />
              <text
                x={MARGIN.l - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-gray-500 text-[11px] tabular-nums"
              >
                {tick === 0 ? "0" : compact(tick)}
              </text>
            </g>
          ))}
          {series.map((point, index) =>
            index % 7 === 0 && index < last - 1 ? (
              <text
                key={point.day}
                x={x(index)}
                y={HEIGHT - 4}
                textAnchor="middle"
                className="fill-gray-500 text-[11px]"
              >
                {dayMonth(point.day)}
              </text>
            ) : null,
          )}
          <path d={area} fill={`url(#${fillId})`} />
          <path
            d={line}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            className="stroke-brand-700"
          />
          <circle
            cx={x(last)}
            cy={y(end)}
            r={4}
            strokeWidth={2}
            className="fill-brand-700 stroke-surface"
          />
          <text
            x={x(last) + 10}
            y={y(end)}
            dominantBaseline="middle"
            className="fill-gray-900 text-xs font-(--w-ui) tabular-nums"
          >
            {compact(end)}
          </text>
          {active !== null ? (
            <g className="pointer-events-none">
              <line
                x1={x(active)}
                x2={x(active)}
                y1={MARGIN.t}
                y2={MARGIN.t + ih}
                className="stroke-gray-400"
              />
              <circle
                cx={x(active)}
                cy={y(values[active] ?? 0)}
                r={4}
                strokeWidth={2}
                className="fill-brand-700 stroke-surface"
              />
            </g>
          ) : null}
          <rect
            x={MARGIN.l - 6}
            y={0}
            width={iw + 12}
            height={HEIGHT - MARGIN.b}
            fill="transparent"
            onPointerMove={(event) => {
              const rect =
                event.currentTarget.ownerSVGElement?.getBoundingClientRect();
              const offset = event.clientX - (rect?.left ?? 0) - MARGIN.l;
              const index = Math.round((offset / Math.max(1, iw)) * last);
              const clamped = Math.min(last, Math.max(0, index));
              hover.show(clamped, {
                x: (rect?.left ?? 0) + x(clamped),
                y: (rect?.top ?? 0) + MARGIN.t + ih / 2,
              });
            }}
            onPointerLeave={hover.hide}
          />
        </svg>
      ) : (
        <div role="img" aria-label={ariaLabel} />
      )}
      <ChartTip
        content={activePoint ? tip(activePoint) : null}
        anchor={hover.anchor}
      />
    </div>
  );
}
