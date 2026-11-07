import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { Children } from "react";

import { Skel } from "./states";

export const MAX_STAT_CARDS = 4;

/** total: gray; attention: amber; danger: red; clear: green, for "All clear". */
export type StatTone = "total" | "attention" | "danger" | "clear";

const ICON_TONES: Record<StatTone, string> = {
  total: "bg-gray-100 text-gray-600",
  attention: "bg-warn-50 text-warn-700",
  danger: "bg-error-50 text-error-700",
  clear: "bg-success-50 text-success-700",
};

const cardClass =
  "flex min-w-0 flex-col items-stretch gap-1 rounded-panel border border-gray-200 bg-surface p-4 text-left text-gray-900 max-[600px]:p-3.5";

/**
 * Company-wide numbers, at most four, never clickable: filtering lives in
 * the chips beside the tabs.
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
        "group/stats mt-4 grid gap-3 [animation-delay:60ms] motion-safe:animate-rise",
        columns === 3
          ? "grid-cols-3 max-[600px]:grid-cols-1 max-[600px]:gap-2"
          : "grid-cols-4 max-[1100px]:grid-cols-2",
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
}: {
  icon: LucideIcon;
  tone: StatTone;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        cardClass,
        "group-data-[columns=3]/stats:max-[600px]:flex-row group-data-[columns=3]/stats:max-[600px]:flex-wrap group-data-[columns=3]/stats:max-[600px]:items-center group-data-[columns=3]/stats:max-[600px]:gap-x-3 group-data-[columns=3]/stats:max-[600px]:py-3",
      )}
    >
      <span className="flex items-center gap-2 text-xs leading-4 font-(--w-ui) text-gray-600 group-data-[columns=3]/stats:max-[600px]:flex-auto">
        <span
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-control",
            ICON_TONES[tone],
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
        </span>
        {label}
      </span>
      <span className="mt-1.5 text-2xl leading-8 font-(--w-figure) tracking-[-0.02em] tabular-nums group-data-[columns=3]/stats:max-[600px]:order-2 group-data-[columns=3]/stats:max-[600px]:mt-0 group-data-[columns=3]/stats:max-[600px]:text-lg group-data-[columns=3]/stats:max-[600px]:leading-[26px] [&_[data-ccy]]:text-[0.6em]">
        {value}
      </span>
      {extra ? (
        <span className="text-sm leading-5 text-gray-600">{extra}</span>
      ) : null}
      {sub ? (
        <span className="text-xs leading-4 text-gray-500 tabular-nums group-data-[columns=3]/stats:max-[600px]:order-3 group-data-[columns=3]/stats:max-[600px]:basis-full group-data-[columns=3]/stats:max-[600px]:pl-8">
          {sub}
        </span>
      ) : null}
    </div>
  );
}

export function StatCardSkeleton(): JSX.Element {
  return (
    <div className={cardClass} aria-hidden="true">
      <Skel width="60%" height={12} />
      <Skel width="45%" height={28} style={{ marginTop: 10 }} />
      <Skel width="70%" height={12} style={{ marginTop: 6 }} />
    </div>
  );
}
