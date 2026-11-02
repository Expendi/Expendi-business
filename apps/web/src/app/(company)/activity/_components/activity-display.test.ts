import { describe, expect, it } from "vitest";

import {
  describeAction,
  describeActor,
  describeChanges,
} from "./activity-display";

describe("describeAction", () => {
  it.each([
    ["category.archived", "Category archived"],
    ["payroll_run.payment_left_out", "Payroll run payment left out"],
    ["withdrawal_address.added", "Withdrawal address added"],
    ["staff_signed_in", "Staff signed in"],
  ])("words %s as %j", (action, words) => {
    // #when
    const described = describeAction(action);

    // #then
    expect(described).toBe(words);
  });
});

describe("describeActor", () => {
  it("names a person, and says when it was Expendi", () => {
    // #when
    const actors = [
      describeActor({ type: "user", name: "Wanjiru Kamau" }),
      describeActor({ type: "user", name: null }),
      describeActor({ type: "staff", name: null }),
      describeActor({ type: "system", name: null }),
    ];

    // #then
    expect(actors).toEqual([
      "Wanjiru Kamau",
      "Someone no longer in the company",
      "Expendi team",
      "Expendi (automatic)",
    ]);
  });
});

describe("describeChanges", () => {
  it("shows what changed, and what was only recorded", () => {
    // #given
    const before = { name: "Flights", etimsNotRequired: false };
    const after = { name: "Air tickets", etimsNotRequired: true };

    // #when
    const lines = describeChanges(before, after);

    // #then
    expect(lines).toEqual([
      "Name: Flights → Air tickets",
      "Etims not required: false → true",
    ]);
  });

  it("shows a value recorded only before, only after, or unchanged", () => {
    // #when
    const lines = describeChanges(
      { role: "admin", status: "active" },
      { status: "active", invitedAt: null },
    );

    // #then
    expect(lines).toEqual([
      "Status: active",
      "Invited at: none",
      "Role was admin",
    ]);
  });

  it("shortens long nested values and ignores values that aren't fields", () => {
    // #when
    const lines = describeChanges(null, {
      claimIds: Array.from({ length: 10 }, (_, index) => `claim-${index}`),
    });
    const nothing = describeChanges("text", [1, 2]);

    // #then
    expect(lines[0]?.length).toBeLessThanOrEqual("Claim ids: ".length + 60);
    expect(lines[0]?.endsWith("…")).toBe(true);
    expect(nothing).toEqual([]);
  });
});
