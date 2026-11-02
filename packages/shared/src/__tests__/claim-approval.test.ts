import { describe, expect, it } from "vitest";

import {
  approveClaimsRequestSchema,
  CLAIM_APPROVAL_MAX_CLAIMS,
  rejectClaimRequestSchema,
} from "../claim-approval.js";

const claimId = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

describe("approveClaimsRequestSchema", () => {
  it("takes one claim, or a batch up to the limit", () => {
    // #given
    const batch = Array.from({ length: CLAIM_APPROVAL_MAX_CLAIMS }, (_, n) =>
      claimId(n),
    );

    // #then
    expect([
      approveClaimsRequestSchema.safeParse({ claimIds: [claimId(1)] }).success,
      approveClaimsRequestSchema.safeParse({ claimIds: batch }).success,
    ]).toEqual([true, true]);
  });

  it.each([
    ["no claims", []],
    [
      "more than the limit",
      Array.from({ length: CLAIM_APPROVAL_MAX_CLAIMS + 1 }, (_, n) =>
        claimId(n),
      ),
    ],
    ["the same claim twice", [claimId(1), claimId(1)]],
    ["something that isn't a claim ID", ["claim-1"]],
  ])("refuses %s", (_case, claimIds) => {
    // #then
    expect(approveClaimsRequestSchema.safeParse({ claimIds }).success).toBe(
      false,
    );
  });
});

describe("rejectClaimRequestSchema", () => {
  it("keeps the reason, trimmed", () => {
    // #when
    const parsed = rejectClaimRequestSchema.parse({
      reason: "  The receipt is unreadable ",
    });

    // #then
    expect(parsed.reason).toBe("The receipt is unreadable");
  });

  it.each([
    ["no reason", {}],
    ["a blank reason", { reason: "     " }],
    ["a one-word shrug", { reason: "no" }],
    ["an essay", { reason: "x".repeat(501) }],
  ])("refuses %s", (_case, body) => {
    // #then
    expect(rejectClaimRequestSchema.safeParse(body).success).toBe(false);
  });
});
