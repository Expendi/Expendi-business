"use client";

import type { JSX } from "react";

import {
  endedOutcome,
  runningOutcome,
} from "~/app/(company)/wallet/_components/treasury-display";
import { MoveProgress } from "~/app/(company)/wallet/_components/treasury-progress";
import { MoveResult } from "~/app/(company)/wallet/_components/treasury-sheets";
import { Callout } from "~/components/data/detail-sheet";
import { PageHeader } from "~/components/data/page-header";
import {
  IN_STEPS,
  OPEN_MOVES,
  openMoveSummary,
  OUT_STEPS,
  progressAt,
} from "./fixtures/treasury";

const STATES = [
  ["move", "Moving to Treasury: leaving the wallet"],
  ["move-way", "Moving to Treasury: on its way"],
  ["move-arriving", "Moving to Treasury: arriving"],
  ["move-split", "A split move: part 2 of 3"],
  ["move-review", "Stopped for review at arriving"],
  ["move-out", "Moving to the wallet: leaving Treasury"],
  ["move-back", "Moving to the wallet: on its way"],
] as const;

const LANDING = {
  ...OPEN_MOVES.move,
  progress: progressAt(IN_STEPS, 3),
};
const IN_WALLET = {
  ...OPEN_MOVES["move-out"],
  progress: progressAt(OUT_STEPS, 2),
};

/**
 * Every state of the move's steps, as the move sheet shows them while it
 * runs and as the Treasury card's callout does, plus the sheet's ends.
 */
export function TreasuryProgressPreview(): JSX.Element {
  const states = [
    ...STATES.map(([key, label]) => [label, OPEN_MOVES[key]] as const),
    ["Moving to Treasury: in Treasury", LANDING] as const,
    ["Moving to the wallet: back in the wallet", IN_WALLET] as const,
  ];
  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Treasury move progress"
        subtitle="The steps on the move sheet, and compact in the Treasury card."
      />
      <div className="grid gap-6 md:grid-cols-2">
        {states.map(([label, open]) => (
          <article
            key={label}
            className="flex flex-col gap-3 rounded-panel border bg-card p-4"
          >
            <h2 className="text-sm font-(--w-ui)">{label}</h2>
            <MoveResult outcome={runningOutcome(openMoveSummary(open), open)} />
            <Callout
              tone={open.status === "needs_review" ? "warn" : "neutral"}
              title={open.statusText}
            >
              <div className="my-2">
                {open.progress ? (
                  <MoveProgress progress={open.progress} compact />
                ) : null}
              </div>
            </Callout>
          </article>
        ))}
        {(["completed", "returned", "failed"] as const).map((status) => (
          <article key={status} className="rounded-panel border bg-card p-4">
            <h2 className="text-sm font-(--w-ui)">Sheet: move {status}</h2>
            <MoveResult
              outcome={endedOutcome({
                ...openMoveSummary(OPEN_MOVES.move),
                status,
                progress: progressAt(IN_STEPS, status === "completed" ? 0 : 1, {
                  finished: status === "completed",
                  stopped: status !== "completed",
                }),
              })}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
