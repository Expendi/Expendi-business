"use client";

import type { JSX } from "react";
import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
  YAxis,
} from "recharts";

import type { DailyBalance } from "./wallet-display";
import type { TipContent } from "~/components/data/chart-tip";
import type { ChartConfig } from "~/components/ui/chart";
import { ChartContainer, ChartTooltip } from "~/components/ui/chart";
import { compact } from "~/lib/chart-scale";
import { dayMonth } from "./wallet-display";

const CONFIG = {
  balance: { label: "Balance", color: "var(--chart-1)" },
} satisfies ChartConfig;

interface BalancePoint {
  readonly day: string;
  readonly value: number;
  readonly source: DailyBalance;
}

/** USDC base units as whole USDC, only for placing the line. */
function usdcValue(units: string): number {
  return Number(BigInt(units) / 10_000n) / 100;
}

/**
 * The balance at the end of each day: a step line, because the balance
 * only moves when money does. The tooltip reads any day; on focus the arrow
 * keys do.
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
  const gradientId = useId().replace(/:/g, "");
  const points: BalancePoint[] = series.map((source) => ({
    day: source.day,
    value: usdcValue(source.units),
    source,
  }));
  const last = points.at(-1);
  const ticks = points
    .filter((_, index) => index % 7 === 0 && index < points.length - 2)
    .map((point) => point.day);

  return (
    <figure aria-label={ariaLabel} className="m-0 mt-2 min-w-0">
      <ChartContainer config={CONFIG} className="aspect-auto h-[180px] w-full">
        <AreaChart
          accessibilityLayer
          data={points}
          margin={{ top: 10, right: 52, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-balance)"
                stopOpacity={0.3}
              />
              <stop
                offset="100%"
                stopColor="var(--color-balance)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="day"
            ticks={ticks}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(day: string) => dayMonth(day)}
          />
          <YAxis
            width={40}
            domain={[0, "auto"]}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              value === 0 ? "0" : compact(value)
            }
          />
          <ChartTooltip
            cursor
            content={({ active, payload }) => {
              const point = payload[0]?.payload as BalancePoint | undefined;
              if (!active || !point) return null;
              const { head, rows, foot } = tip(point.source);
              return (
                <div className="grid min-w-36 gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <p className="font-medium">{head}</p>
                  {rows.map((row) => (
                    <p key={row.key} className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-medium tabular-nums">
                        {row.value}
                      </span>
                    </p>
                  ))}
                  {foot ? (
                    <p className="text-muted-foreground tabular-nums">{foot}</p>
                  ) : null}
                </div>
              );
            }}
          />
          <Area
            dataKey="value"
            type="stepAfter"
            stroke="var(--color-balance)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
          />
          {last ? (
            <ReferenceDot
              x={last.day}
              y={last.value}
              r={4}
              fill="var(--color-balance)"
              stroke="var(--card)"
              strokeWidth={2}
              ifOverflow="visible"
              label={{
                value: compact(last.value),
                position: "right",
                offset: 8,
                className: "fill-foreground text-xs tabular-nums",
              }}
            />
          ) : null}
        </AreaChart>
      </ChartContainer>
    </figure>
  );
}
