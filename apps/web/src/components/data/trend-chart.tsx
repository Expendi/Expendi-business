"use client";

import type { JSX } from "react";
import { cn } from "cn";
import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import type { ChartConfig } from "~/components/ui/chart";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";

export interface TrendSeries {
  /** The field of each point this series plots. */
  readonly key: string;
  readonly label: string;
  /** A CSS colour; defaults to `--chart-1`, `--chart-2`… in order. */
  readonly color?: string;
}

export type TrendPoint = Readonly<Record<string, string | number>>;

/**
 * The template's chart pattern on shadcn's `ui/chart` (Recharts): one or
 * more series over a category axis, as stacked areas or grouped bars, with
 * the brand chart colours, a tooltip and, for two or more series, a legend.
 * Put it in a `Card`; give it an accessible `label` describing the data.
 */
export function TrendChart({
  label,
  data,
  xKey,
  series,
  kind = "area",
  formatValue,
  formatTick = (value) => value,
  className,
}: {
  /** What the chart shows, read out in place of the drawing. */
  label: string;
  data: readonly TrendPoint[];
  /** The category field, e.g. "month". */
  xKey: string;
  series: readonly TrendSeries[];
  kind?: "area" | "bar";
  /** Tooltip values, e.g. KES amounts. */
  formatValue?: (value: number) => string;
  /** Axis labels, e.g. "2026-10" → "Oct". */
  formatTick?: (value: string) => string;
  className?: string;
}): JSX.Element {
  const gradientId = useId().replace(/:/g, "");
  const config: ChartConfig = Object.fromEntries(
    series.map((item, index) => [
      item.key,
      {
        label: item.label,
        color: item.color ?? `var(--chart-${String((index % 5) + 1)})`,
      },
    ]),
  );
  const points = [...data];
  const tooltip = (
    <ChartTooltip
      cursor={kind === "bar" ? { fillOpacity: 0.4 } : true}
      content={
        <ChartTooltipContent
          indicator={kind === "bar" ? "dot" : "line"}
          formatter={
            formatValue
              ? (value, name) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">
                      {config[String(name)]?.label ?? String(name)}
                    </span>
                    <span className="font-medium text-foreground tabular-nums">
                      {typeof value === "number"
                        ? formatValue(value)
                        : String(value)}
                    </span>
                  </span>
                )
              : undefined
          }
        />
      }
    />
  );
  const axis = (
    <XAxis
      dataKey={xKey}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={24}
      tickFormatter={(value: string) => formatTick(String(value))}
    />
  );
  const legend =
    series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null;

  return (
    <figure aria-label={label} className={cn("m-0 min-w-0", className)}>
      <ChartContainer
        config={config}
        className="aspect-auto h-64 w-full"
        aria-hidden="true"
      >
        {kind === "bar" ? (
          <BarChart data={points} margin={{ left: 4, right: 4 }}>
            <CartesianGrid vertical={false} />
            {axis}
            {tooltip}
            {series.map((item) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                radius={4}
              />
            ))}
            {legend}
          </BarChart>
        ) : (
          <AreaChart data={points} margin={{ left: 4, right: 4 }}>
            <defs>
              {series.map((item) => (
                <linearGradient
                  key={item.key}
                  id={`${gradientId}-${item.key}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={`var(--color-${item.key})`}
                    stopOpacity={0.6}
                  />
                  <stop
                    offset="95%"
                    stopColor={`var(--color-${item.key})`}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} />
            {axis}
            {tooltip}
            {series.map((item) => (
              <Area
                key={item.key}
                dataKey={item.key}
                type="natural"
                fill={`url(#${gradientId}-${item.key})`}
                stroke={`var(--color-${item.key})`}
                strokeWidth={2}
                stackId={series.length > 1 ? "stack" : undefined}
              />
            ))}
            {legend}
          </AreaChart>
        )}
      </ChartContainer>
    </figure>
  );
}
