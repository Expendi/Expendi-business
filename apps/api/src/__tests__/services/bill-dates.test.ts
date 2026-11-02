import { describe, expect, it } from "vitest";

import { nairobiDate, scheduledStatus } from "../../services/bills/status.js";
import { billStatusJob } from "../../station/bill-status.js";
import { confirmOnchainJob } from "../../station/confirm-onchain.js";
import { reconcilePaycrestJob } from "../../station/reconcile-paycrest.js";

describe("nairobiDate", () => {
  it.each([
    ["2026-03-31T20:59:59.999Z", "2026-03-31"],
    ["2026-03-31T21:00:00.000Z", "2026-04-01"],
    ["2026-02-28T21:00:00.000Z", "2026-03-01"],
    ["2028-02-28T21:00:00.000Z", "2028-02-29"],
    ["2026-12-31T20:59:00.000Z", "2026-12-31"],
    ["2026-12-31T21:00:00.000Z", "2027-01-01"],
    ["2026-06-15T00:00:00.000Z", "2026-06-15"],
  ])("%s is %s in Nairobi", (instant, expected) => {
    // #when
    const day = nairobiDate(new Date(instant));

    // #then
    expect(day).toBe(expected);
  });
});

describe("scheduledStatus", () => {
  it.each([
    ["2026-04-02", "upcoming"],
    ["2026-04-01", "due"],
    ["2026-03-31", "overdue"],
    ["2025-12-31", "overdue"],
  ] as const)("a bill due %s is %s on 2026-04-01", (dueOn, status) => {
    // #when
    const result = scheduledStatus(dueOn, "2026-04-01");

    // #then
    expect(result).toBe(status);
  });
});

describe("billStatusJob", () => {
  it("has its own advisory lock key", () => {
    // #given
    const keys = [reconcilePaycrestJob, confirmOnchainJob, billStatusJob].map(
      (job) => job.lockKey,
    );

    // #then
    expect(new Set(keys).size).toBe(keys.length);
  });
});
