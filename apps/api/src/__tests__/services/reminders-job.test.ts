import { describe, expect, it } from "vitest";

import type { RemindersRun } from "../../services/notification/reminders.js";
import { remindersOutcome } from "../../station/reminders.js";
import { IDLE } from "../../station/scheduler.js";

const QUIET: RemindersRun = {
  today: "2026-11-13",
  companies: 3,
  bills: 0,
  walletWarnings: 0,
  cardBalanceWarnings: 0,
  failed: 0,
};

describe("the reminders job's report to the station", () => {
  it("is idle before the reminder hour and when nothing went out", () => {
    // #then
    expect([remindersOutcome(null), remindersOutcome(QUIET)]).toEqual([
      IDLE,
      IDLE,
    ]);
  });

  it.each<[string, Partial<RemindersRun>]>([
    ["a bill reminder", { bills: 1 }],
    ["a wallet-short warning", { walletWarnings: 1 }],
    ["only a Card balance warning", { cardBalanceWarnings: 1 }],
    ["a failure", { failed: 1 }],
  ])("reports a run that sent %s", (_case, sent) => {
    // #given
    const run = { ...QUIET, ...sent };

    // #then
    expect(remindersOutcome(run)).toEqual(run);
  });
});
