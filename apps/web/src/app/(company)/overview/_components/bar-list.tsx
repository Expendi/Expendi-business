"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";

import type { TipContent } from "~/components/data/chart-tip";
import { ChartTip, useChartHover } from "~/components/data/chart-tip";

export interface BarRow {
  readonly id: string;
  readonly name: string;
  /** Whole shillings, to size the bar. */
  readonly value: number;
  /** The month before, drawn as a tick on the track. */
  readonly previous?: number;
  readonly valueText: ReactNode;
  /** e.g. "+31%", shown after the value. */
  readonly delta?: string | null;
  /** A rise worth noticing, so the delta is darker. */
  readonly up?: boolean;
  readonly ariaLabel: string;
  readonly tip: TipContent;
}

/**
 * Ranked horizontal bars: name, a thin coral bar with the month before as
 * a gray tick, and the value. Each row is a hover and focus target.
 */
export function BarList({
  rows,
  max,
  label,
}: {
  rows: readonly BarRow[];
  /** The value a full track stands for. */
  max: number;
  label: string;
}): JSX.Element {
  const hover = useChartHover();
  const percent = (value: number) =>
    `${((Math.max(0, value) / Math.max(1, max)) * 100).toFixed(2)}%`;
  return (
    <>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((row, index) => (
          <li
            key={row.id}
            tabIndex={0}
            aria-label={row.ariaLabel}
            onPointerMove={(event) =>
              hover.show(index, { x: event.clientX, y: event.clientY })
            }
            onPointerLeave={hover.hide}
            onFocus={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              hover.show(index, {
                x: rect.right - 140,
                y: rect.top + rect.height / 2,
              });
            }}
            onBlur={hover.hide}
            className="group/bar -mx-2 grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_8.5rem] items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-150 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring max-[600px]:grid-cols-[minmax(0,1fr)_auto] max-[600px]:gap-y-1.5"
          >
            <span
              title={row.name}
              className="truncate text-sm text-muted-foreground"
            >
              {row.name}
            </span>
            <span
              aria-hidden="true"
              className="relative h-2.5 max-[600px]:col-span-2 max-[600px]:row-start-2"
            >
              <span
                style={{ width: percent(row.value) }}
                className="absolute inset-y-0 left-0 min-w-1 origin-left rounded-r-[4px] bg-(--chart-1) transition-colors duration-150 group-hover/bar:bg-(--chart-1)/85 group-focus-visible/bar:bg-(--chart-1)/85"
              />
              {row.previous !== undefined && row.previous > 0 ? (
                <span
                  style={{ left: `calc(${percent(row.previous)} - 1px)` }}
                  className="absolute -inset-y-[3px] w-0.5 rounded-[1px] bg-muted-foreground shadow-[0_0_0_2px_var(--card)]"
                />
              ) : null}
            </span>
            <span className="text-right text-sm whitespace-nowrap tabular-nums">
              {row.valueText}
              {row.delta ? (
                <span
                  className={cn(
                    "ml-1.5",
                    row.up
                      ? "font-(--w-ui) text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {row.delta}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <ChartTip
        content={
          hover.active === null ? null : (rows[hover.active]?.tip ?? null)
        }
        anchor={hover.anchor}
      />
    </>
  );
}
