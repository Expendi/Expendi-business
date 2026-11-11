"use client";

import type { JSX } from "react";
import { cn } from "cn";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

import type { ChartConfig } from "~/components/ui/chart";
import { ChartContainer, ChartTooltip } from "~/components/ui/chart";
import { compact } from "~/lib/chart-scale";

/** What the tooltip says about one month: a heading, rows and a closing line. */
export interface MonthTip {
  readonly head: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly foot?: string | null;
}

const CONFIG: ChartConfig = {
  value: { label: "Money out", color: "var(--chart-1)" },
};

/**
 * One series over months as a shadcn chart: the chosen month in the primary
 * chart colour, the others muted. Recharts' accessibility layer lets the
 * arrow keys read each month.
 */
export function MonthBars({
  labels,
  values,
  selected,
  axis,
  ariaLabel,
  tip,
  className,
}: {
  /** Under each column, e.g. "Oct". */
  labels: readonly string[];
  /** Whole shillings, lined up with `labels`. */
  values: readonly number[];
  /** The highlighted column; -1 for none. */
  selected: number;
  /** A labelled y-axis with gridlines; without it, bars and months only. */
  axis: boolean;
  ariaLabel: string;
  tip: (index: number) => MonthTip;
  className?: string;
}): JSX.Element {
  const data = labels.map((label, index) => ({
    index,
    label,
    value: values[index] ?? 0,
  }));
  return (
    <figure aria-label={ariaLabel} className="m-0 min-w-0">
      <ChartContainer
        config={CONFIG}
        className={cn("aspect-auto h-48 w-full", className)}
      >
        <BarChart
          data={data}
          margin={{ top: 8, right: 4, bottom: 0, left: axis ? 0 : 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="preserveStartEnd"
            minTickGap={axis ? 8 : 16}
          />
          {axis ? (
            <YAxis
              width={44}
              tickLine={false}
              axisLine={false}
              tickMargin={4}
              tickCount={5}
              tickFormatter={(value: number) =>
                value === 0 ? "0" : compact(value)
              }
            />
          ) : null}
          <ChartTooltip
            cursor={{ fillOpacity: 0.4 }}
            content={({ active, payload }) => {
              const index = hoveredIndex(payload[0]?.payload);
              if (!active || index === null) return null;
              return <MonthTooltip tip={tip(index)} />;
            }}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={28}>
            {data.map((point) => (
              <Cell
                key={point.index}
                fill={
                  point.index === selected
                    ? "var(--color-value)"
                    : "var(--muted-foreground)"
                }
                fillOpacity={point.index === selected ? 1 : 0.3}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </figure>
  );
}

function hoveredIndex(point: unknown): number | null {
  return typeof point === "object" &&
    point !== null &&
    "index" in point &&
    typeof point.index === "number"
    ? point.index
    : null;
}

function MonthTooltip({ tip }: { tip: MonthTip }): JSX.Element {
  return (
    <div className="grid min-w-36 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{tip.head}</div>
      <div className="grid gap-1">
        {tip.rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4"
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-medium text-foreground tabular-nums">
              {row.value}
            </span>
          </div>
        ))}
      </div>
      {tip.foot ? (
        <div className="border-t border-border pt-1.5 text-muted-foreground">
          {tip.foot}
        </div>
      ) : null}
    </div>
  );
}
