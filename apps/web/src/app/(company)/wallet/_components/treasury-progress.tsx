import type { JSX } from "react";
import { cn } from "cn";
import { CheckIcon, XIcon } from "lucide-react";

import type {
  TreasuryProgress,
  TreasuryProgressStep,
} from "@expendi-business/shared";

import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { PROGRESS_STATE_WORDS, PROGRESS_STEP_LABELS } from "./treasury-display";

type StepState = TreasuryProgressStep["state"];

const MARK_CLASSES: Record<StepState, string> = {
  done: "bg-success-50 text-success-700",
  current: "border-2 border-primary",
  waiting: "border border-border",
  failed: "bg-error-50 text-error-700",
};

function StepMark({
  state,
  compact,
}: {
  state: StepState;
  compact: boolean;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-full",
        compact ? "size-4" : "size-5",
        MARK_CLASSES[state],
      )}
    >
      {state === "done" ? <CheckIcon className="size-3" /> : null}
      {state === "failed" ? <XIcon className="size-3" /> : null}
      {state === "current" ? (
        <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
      ) : null}
    </span>
  );
}

/**
 * Where a move's money is, one line per step: done, in progress, waiting or
 * where it stopped. Plain words only. `compact` is for the Treasury card's
 * callout; `showTimes` adds when each finished step completed.
 */
export function MoveProgress({
  progress,
  compact = false,
  showTimes = false,
}: {
  progress: TreasuryProgress;
  compact?: boolean;
  showTimes?: boolean;
}): JSX.Element {
  return (
    <div>
      {progress.part !== undefined && progress.parts !== undefined ? (
        <p className="mb-1 text-xs leading-4 font-(--w-ui) text-muted-foreground tabular-nums">
          Part {progress.part} of {progress.parts}
        </p>
      ) : null}
      <ol aria-label="Move progress">
        {progress.steps.map((step) => (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            data-state={step.state}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 text-sm leading-5",
              compact ? "py-0.5" : "py-1.5",
            )}
          >
            <StepMark state={step.state} compact={compact} />
            <span
              className={cn(
                step.state === "waiting" && "text-muted-foreground",
                step.state === "current" && "font-(--w-ui) text-foreground",
                step.state === "failed" && "font-(--w-ui) text-error-700",
              )}
            >
              {PROGRESS_STEP_LABELS[step.key]}
              <span className="sr-only">
                {`: ${PROGRESS_STATE_WORDS[step.state]}`}
              </span>
            </span>
            {showTimes && step.at ? (
              <time
                dateTime={step.at}
                className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums"
              >
                {formatNairobiDateTime(step.at)}
              </time>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
