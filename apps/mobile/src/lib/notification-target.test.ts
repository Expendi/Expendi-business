import { describe, expect, it } from "vitest";

import { notificationTarget } from "./notification-target";

const ORGANIZATION_ID = "5b0f6a52-3d8e-4c1a-9f7e-2a4b6c8d0e1f";
const CLAIM_ID = "8c2d4e6f-1a3b-4c5d-8e7f-9a0b1c2d3e4f";

describe("notificationTarget", () => {
  it.each([
    "claim_submitted",
    "claim_rejected",
    "claim_paid",
    "claim_payout_failed",
  ])("opens the claim for %s", (type) => {
    // #when
    const target = notificationTarget({
      type,
      organizationId: ORGANIZATION_ID,
      claimId: CLAIM_ID,
    });

    // #then
    expect(target).toEqual({
      organizationId: ORGANIZATION_ID,
      claimId: CLAIM_ID,
    });
  });

  it.each([
    ["nothing", undefined],
    ["an empty payload", {}],
    [
      "a kind this version doesn't know",
      { type: "bill_due", organizationId: ORGANIZATION_ID, claimId: CLAIM_ID },
    ],
    [
      "a claim ID that isn't one",
      { type: "claim_paid", organizationId: ORGANIZATION_ID, claimId: "../x" },
    ],
    ["no company", { type: "claim_paid", claimId: CLAIM_ID }],
  ])("ignores %s", (_label, data) => {
    // #when
    const target = notificationTarget(data);

    // #then
    expect(target).toBeNull();
  });
});
