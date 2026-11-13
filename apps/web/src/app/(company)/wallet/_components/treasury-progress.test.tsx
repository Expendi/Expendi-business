import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  TreasuryMoveSummary,
  TreasuryStatus,
} from "@expendi-business/shared";

import {
  IN_STEPS,
  OPEN_MOVES,
  openMoveSummary,
  OUT_STEPS,
  progressAt,
  TREASURY_MOVES,
  TREASURY_STATUSES,
} from "~/app/dev/preview/_harness/fixtures/treasury";
import { MoveRow, TreasuryCard } from "./treasury-card";
import {
  endedOutcome,
  moveHasEnded,
  pollIntervalFor,
  PROGRESS_STEP_LABELS,
  runningOutcome,
  WATCHED_MOVE_POLL_MS,
} from "./treasury-display";
import { MoveProgress } from "./treasury-progress";
import { MoveResult } from "./treasury-sheets";

const ON_STATUS = TREASURY_STATUSES.on as Extract<
  TreasuryStatus,
  { status: "on" }
>;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll(" :", ":")
    .replaceAll("&#x27;", "'");

const states = (html: string) =>
  [...html.matchAll(/data-state="(\w+)"/g)].map((match) => match[1]);

const render = (progress: Parameters<typeof MoveProgress>[0]["progress"]) =>
  renderToStaticMarkup(<MoveProgress progress={progress} showTimes />);

describe("the move's steps", () => {
  it("names each step to Treasury in plain words, in order", () => {
    // #when
    const html = render(progressAt(IN_STEPS, 0));

    // #then
    expect(text(html)).toContain(
      "Leaving your wallet: in progress On its way: waiting Arriving in Treasury: waiting In Treasury: waiting",
    );
  });

  it("names each step back to the wallet in plain words, in order", () => {
    // #when
    const html = render(progressAt(OUT_STEPS, 0));

    // #then
    expect(text(html)).toContain(
      "Leaving Treasury: in progress On its way: waiting Back in your wallet: waiting",
    );
  });

  it.each([
    [0, ["current", "waiting", "waiting", "waiting"]],
    [1, ["done", "current", "waiting", "waiting"]],
    [2, ["done", "done", "current", "waiting"]],
    [3, ["done", "done", "done", "current"]],
  ] as const)("shows done, current and waiting at step %i", (at, expected) => {
    // #when
    const html = render(progressAt(IN_STEPS, at));

    // #then
    expect(states(html)).toEqual(expected);
  });

  it("marks the current step for assistive technology and only that one", () => {
    // #when
    const html = render(progressAt(OUT_STEPS, 1));

    // #then
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(text(html)).toContain("On its way: in progress");
  });

  it("shows where a move stopped as failed, with the steps after it waiting", () => {
    // #when
    const html = render(progressAt(IN_STEPS, 2, { stopped: true }));

    // #then
    expect(states(html)).toEqual(["done", "done", "failed", "waiting"]);
    expect(text(html)).toContain("Arriving in Treasury: stopped here");
  });

  it("says which part of a split move it shows, and nothing for a whole move", () => {
    // #when
    const split = render(progressAt(IN_STEPS, 1, { part: 2, parts: 3 }));
    const whole = render(progressAt(IN_STEPS, 1));

    // #then
    expect(text(split)).toContain("Part 2 of 3");
    expect(text(whole)).not.toContain("Part");
  });

  it("shows when each finished step completed, and no time for the others", () => {
    // #when
    const html = render(progressAt(IN_STEPS, 2));

    // #then two done steps have a time; the current and waiting ones don't
    expect(html.match(/<time /g)).toHaveLength(2);
    expect(text(html)).toContain("6 Nov 2026, 09:23");
    expect(
      renderToStaticMarkup(<MoveProgress progress={progressAt(IN_STEPS, 2)} />),
    ).not.toContain("<time");
  });

  it("names no chain or provider", () => {
    // #when
    const words = Object.values(PROGRESS_STEP_LABELS).join(" ");

    // #then
    expect(words).not.toMatch(/near|base|1click|privy|intents|vault|usdc/i);
  });
});

describe("the steps where a move shows", () => {
  const shownWith = (key: keyof typeof OPEN_MOVES) => {
    const status = {
      ...TREASURY_STATUSES.on,
      openMove: OPEN_MOVES[key],
    } as Extract<TreasuryStatus, { status: "on" }>;
    return renderToStaticMarkup(
      <TreasuryCard
        status={status}
        moves={[]}
        canAct
        onTurnOn={() => undefined}
        onMove={() => undefined}
      />,
    );
  };

  it("puts the compact steps in the Treasury card's open-move callout", () => {
    // #when
    const html = shownWith("move-way");

    // #then
    expect(text(html)).toContain("On its way to Treasury");
    expect(states(html)).toEqual(["done", "current", "waiting", "waiting"]);
  });

  it("shows a move under review as stopped, beside its plain status", () => {
    // #when
    const html = shownWith("move-review");

    // #then
    expect(text(html)).toContain("Being checked by Expendi");
    expect(states(html)).toEqual(["done", "done", "failed", "waiting"]);
  });

  it("falls back to the text alone when the API sent no steps", () => {
    // #given an older API
    const { progress: _progress, ...bare } = OPEN_MOVES.move;
    const status = {
      ...TREASURY_STATUSES.on,
      openMove: bare,
    } as Extract<TreasuryStatus, { status: "on" }>;

    // #when
    const html = renderToStaticMarkup(
      <TreasuryCard
        status={status}
        moves={[]}
        canAct
        onTurnOn={() => undefined}
        onMove={() => undefined}
      />,
    );

    // #then
    expect(text(html)).toContain("On its way to Treasury");
    expect(html).not.toContain("Move progress");
  });

  const [done] = TREASURY_MOVES;
  if (!done) throw new Error("no sample move");

  it("keeps a history row's steps folded until asked", () => {
    // #when
    const html = renderToStaticMarkup(<MoveRow move={done} />);

    // #then
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toContain("Show steps");
    expect(html).not.toContain("Move progress");
  });

  it("unfolds a history row to its steps with their times", () => {
    // #when
    const html = renderToStaticMarkup(<MoveRow move={done} defaultExpanded />);

    // #then
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain("Hide steps");
    expect(states(html)).toEqual(["done", "done", "done"]);
    expect(html.match(/<time /g)).toHaveLength(3);
  });

  it("offers no steps for a move the API sent none for", () => {
    // #when
    const { progress: _progress, ...bare } = done;
    const html = renderToStaticMarkup(<MoveRow move={bare} />);

    // #then
    expect(text(html)).not.toContain("Show steps");
  });

  it("shows the steps on the move sheet with the move's words above them", () => {
    // #when
    const open = OPEN_MOVES["move-split"];
    const html = renderToStaticMarkup(
      <MoveResult outcome={runningOutcome(openMoveSummary(open), open)} />,
    );

    // #then
    expect(text(html)).toContain("Move started");
    expect(text(html)).toContain("Part 2 of 3");
    expect(states(html)).toEqual(["done", "current", "waiting", "waiting"]);
  });
});

describe("what the sheet says as the move runs and ends", () => {
  const base = openMoveSummary(OPEN_MOVES.move);
  const ended = (status: TreasuryMoveSummary["status"]) =>
    endedOutcome({
      ...base,
      status,
      movedUsdc: "999540000",
      progress: progressAt(IN_STEPS, 1, { stopped: true }),
    });

  it("says a running move is on its way, to Treasury or to the wallet", () => {
    // #when
    const toTreasury = runningOutcome(base, OPEN_MOVES.move);
    const toWallet = runningOutcome(
      openMoveSummary(OPEN_MOVES["move-out"]),
      OPEN_MOVES["move-out"],
    );

    // #then
    expect([toTreasury.text, toWallet.text]).toEqual([
      "1,000.00 USDC is on its way to Treasury.",
      "1,000.00 USDC is on its way to your wallet. It can be spent once it arrives.",
    ]);
  });

  it("says a move under review is being checked, keeping the stopped step", () => {
    // #when
    const outcome = runningOutcome(base, OPEN_MOVES["move-review"]);

    // #then
    expect({
      tone: outcome.tone,
      title: outcome.title,
      failed: outcome.progress?.steps.filter((step) => step.state === "failed"),
    }).toEqual({
      tone: "warn",
      title: "Being checked",
      failed: [expect.objectContaining({ key: "arriving" })],
    });
  });

  it("shows the final state: complete, returned, or didn't go through, each with its steps", () => {
    // #then
    expect(
      (["completed", "returned", "failed"] as const).map((status) => {
        const outcome = ended(status);
        return [outcome.tone, outcome.title, outcome.progress !== null];
      }),
    ).toEqual([
      ["success", "Move complete", true],
      ["warn", "Move returned", true],
      ["error", "Move didn't go through", true],
    ]);
    expect(ended("completed").text).toBe("999.54 USDC is in Treasury.");
  });
});

describe("when the account is asked again", () => {
  it("asks every four seconds while a move is open, and not at all once it ends", () => {
    // #then
    expect(WATCHED_MOVE_POLL_MS).toBe(4_000);
    expect(pollIntervalFor(TREASURY_STATUSES.move, WATCHED_MOVE_POLL_MS)).toBe(
      4_000,
    );
    expect(pollIntervalFor(TREASURY_STATUSES.on, WATCHED_MOVE_POLL_MS)).toBe(
      false,
    );
    expect(pollIntervalFor(TREASURY_STATUSES.off, WATCHED_MOVE_POLL_MS)).toBe(
      false,
    );
    expect(pollIntervalFor(undefined, WATCHED_MOVE_POLL_MS)).toBe(false);
  });

  const id = OPEN_MOVES.move.id;

  it("does not call the move ended on an answer read before the watch began", () => {
    // #then a cached answer with no open move says nothing about this move
    expect(moveHasEnded(TREASURY_STATUSES.on, 900, 1_000, id)).toBe(false);
    expect(moveHasEnded(undefined, 2_000, 1_000, id)).toBe(false);
  });

  it("calls the move ended once a fresh answer has no open move, or another one", () => {
    // #then
    expect(moveHasEnded(TREASURY_STATUSES.on, 2_000, 1_000, id)).toBe(true);
    expect(
      moveHasEnded(
        { ...ON_STATUS, openMove: { ...OPEN_MOVES.move, id: "x" } },
        2_000,
        1_000,
        id,
      ),
    ).toBe(true);
  });

  it("keeps watching while a fresh answer still has this move open", () => {
    // #then
    expect(moveHasEnded(TREASURY_STATUSES.move, 2_000, 1_000, id)).toBe(false);
  });
});
