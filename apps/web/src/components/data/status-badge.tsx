import type { JSX, ReactNode } from "react";
import { cn } from "cn";

/**
 * A filled tint means it needs attention or money is moving; `quiet` is an
 * outline for something that is only a record.
 */
export type StatusTone =
  "waiting" | "moving" | "paid" | "failed" | "rejected" | "quiet" | "overdue";

const TONES: Record<StatusTone, string> = {
  waiting: "bg-warn-50 text-warn-700",
  moving: "bg-blue-50 text-blue-700",
  paid: "bg-success-50 text-success-700",
  failed: "bg-error-50 text-error-700",
  rejected: "bg-gray-100 text-gray-700",
  quiet: "border-gray-200 bg-surface text-gray-600",
  overdue: "bg-error-50 text-error-700",
};

/** A colour tint and its label. Never colour alone, never a dot. */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full border border-transparent px-2 text-xs font-(--w-ui) whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
