import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Children } from "react";

import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "~/components/ui/card";
import { Skel } from "./states";

export const MAX_STAT_CARDS = 4;

/** total: gray; attention: amber; danger: red; clear: green, for "All clear". */
export type StatTone = "total" | "attention" | "danger" | "clear";

const ICON_TONES: Record<StatTone, string> = {
  total: "border-border bg-muted text-muted-foreground",
  attention: "border-transparent bg-warn-50 text-warn-700",
  danger: "border-transparent bg-error-50 text-error-700",
  clear: "border-transparent bg-success-50 text-success-700",
};

/** A change since the last period; neutral, since "up" isn't always good. */
export interface StatTrend {
  readonly direction: "up" | "down";
  /** e.g. "+12% on October", read out in full. */
  readonly label: string;
}

const cardClass =
  "min-w-0 gap-3 shadow-xs max-[600px]:gap-1.5 max-[600px]:py-3";

/**
 * Company-wide numbers as the template's KPI cards, at most four, never
 * clickable: filtering lives in the chips beside the tabs.
 */
export function StatCards({
  label = "Summary",
  columns = 4,
  children,
}: {
  label?: string;
  /** Three cards stay on one row, and become compact rows on a phone (Team). */
  columns?: 3 | 4;
  children: ReactNode;
}): JSX.Element {
  if (
    process.env.NODE_ENV === "development" &&
    Children.count(children) > MAX_STAT_CARDS
  ) {
    console.error(`StatCards shows at most ${String(MAX_STAT_CARDS)} cards.`);
  }
  return (
    <div
      role="group"
      aria-label={label}
      data-columns={columns}
      className={cn(
        "group/stats mt-4 grid gap-4 [animation-delay:60ms] motion-safe:animate-rise",
        columns === 3
          ? "grid-cols-3 max-[600px]:grid-cols-1 max-[600px]:gap-2"
          : "grid-cols-4 max-[1100px]:grid-cols-2 max-[600px]:gap-2",
      )}
    >
      {children}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  tone,
  label,
  value,
  sub,
  extra,
  trend,
}: {
  icon: LucideIcon;
  tone: StatTone;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  trend?: StatTrend;
}): JSX.Element {
  const TrendIcon =
    trend?.direction === "down" ? TrendingDownIcon : TrendingUpIcon;
  return (
    <Card size="sm" className={cardClass}>
      <CardHeader className="flex items-center gap-2 max-[600px]:px-3.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg border",
            ICON_TONES[tone],
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <CardDescription className="min-w-0 text-sm">{label}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 max-[600px]:px-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xl leading-9 font-(--w-amount) tracking-tight text-card-foreground tabular-nums max-[600px]:text-xl max-[600px]:leading-7 [&_[data-ccy]]:text-[0.55em]">
            {value}
          </span>
          {trend ? (
            <Badge variant="outline" aria-label={trend.label}>
              <TrendIcon aria-hidden="true" />
              <span aria-hidden="true">{trend.label}</span>
            </Badge>
          ) : null}
        </div>
        {extra ? (
          <span className="text-sm leading-5 text-muted-foreground">
            {extra}
          </span>
        ) : null}
        {sub ? (
          <span className="text-xs leading-4 text-muted-foreground tabular-nums">
            {sub}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function StatCardSkeleton(): JSX.Element {
  return (
    <Card size="sm" className={cardClass} aria-hidden="true">
      <CardHeader className="flex items-center gap-2">
        <Skel width={28} height={28} />
        <Skel width="50%" height={12} />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Skel width="45%" height={30} />
        <Skel width="70%" height={12} />
      </CardContent>
    </Card>
  );
}
