import { describe, expect, it } from "vitest";

import { auditActionLabel } from "./audit-actions";

const TREASURY_ACTIONS = [
  "treasury.turned_on",
  "treasury_move.started",
  "treasury_move.completed",
  "treasury_move.returned",
  "treasury_move.failed",
  "treasury_move.needs_review",
  "treasury_move.return_started",
  "wallet.treasury_returned",
] as const;

describe("auditActionLabel", () => {
  it("labels every Treasury action the API writes", () => {
    // #then
    expect(
      TREASURY_ACTIONS.filter((action) => auditActionLabel(action) === null),
    ).toEqual([]);
  });

  it("gives each Treasury action its own label", () => {
    // #when
    const labels = TREASURY_ACTIONS.map((action) => auditActionLabel(action));

    // #then
    expect(new Set(labels).size).toBe(TREASURY_ACTIONS.length);
  });

  it("has none for an action it doesn't know, so the code is shown alone", () => {
    // #then
    expect(auditActionLabel("payout.resolved")).toBeNull();
  });
});
