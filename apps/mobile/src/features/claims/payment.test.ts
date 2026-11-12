import { describe, expect, it } from "vitest";

import type {
  ClaimApproval,
  ClaimPaymentPreview,
  ClaimPaymentResult,
} from "@expendi-business/shared";

import { ApiError } from "../../lib/api";
import {
  CHALLENGE_REUSE_MS,
  describePaymentResult,
  isChallengeFresh,
  previewRows,
  sameCost,
  topUpFrom,
} from "./payment";

const CLAIM_ID = "0b9f6c1e-3c2a-4d5e-8f70-1a2b3c4d5e6f";
const PAYOUT_ID = "1c0a7d2f-4d3b-4e6f-9a81-2b3c4d5e6f70";

const PREVIEW: ClaimPaymentPreview = {
  claimId: CLAIM_ID,
  payoutId: PAYOUT_ID,
  claimantName: "Jane Wanjiku",
  phoneLast4: "5678",
  claimedKes: "150050",
  receivesKes: "150100",
  rate: "128.68",
  usdc: "11664594",
  feeAllowanceUsdc: "308918",
  maxDebitUsdc: "11973512",
};

function approval(
  overrides: Partial<ClaimApproval["totals"]> = {},
): ClaimApproval {
  return {
    challengeId: "2d1b8e3a-5e4c-4f70-8b92-3c4d5e6f7081",
    options: { challenge: "abc" },
    claims: [PREVIEW],
    totals: {
      receivesKes: "150100",
      usdc: "11664594",
      feeAllowanceUsdc: "308918",
      maxDebitUsdc: "11973512",
      ...overrides,
    },
    wallet: { availableUsdc: "100000000", shortfallUsdc: "0", topUpKes: null },
  };
}

function result(
  ...claims: [
    ClaimPaymentResult["claims"][number]["status"],
    ClaimPaymentResult["claims"][number]["payout"]["status"],
    string | null,
  ][]
): ClaimPaymentResult {
  return {
    claims: claims.map(([status, payoutStatus, failureReason]) => ({
      claimId: CLAIM_ID,
      status,
      payout: { id: PAYOUT_ID, status: payoutStatus, failureReason },
    })),
  };
}

describe("isChallengeFresh", () => {
  it.each([
    [0, true],
    [CHALLENGE_REUSE_MS - 1, true],
    [CHALLENGE_REUSE_MS, false],
    [5 * 60_000, false],
  ])("after %i ms is %s", (age, expected) => {
    // #when
    const fresh = isChallengeFresh(1_000_000, 1_000_000 + age);

    // #then
    expect(fresh).toBe(expected);
  });
});

describe("sameCost", () => {
  it("holds when nothing the admin reviewed changed", () => {
    // #when
    const same = sameCost(approval(), approval());

    // #then
    expect(same).toBe(true);
  });

  it.each([
    ["the most USDC that can leave", { maxDebitUsdc: "11973513" }],
    ["what the employee receives", { receivesKes: "150200" }],
  ])("breaks when %s changed", (_case, change) => {
    // #when
    const same = sameCost(approval(), approval(change));

    // #then
    expect(same).toBe(false);
  });
});

describe("previewRows", () => {
  it("shows the KES received, where it goes, the USDC, the fee allowance and the total", () => {
    // #when
    const rows = previewRows(PREVIEW);

    // #then
    expect(rows).toEqual([
      { label: "They receive", value: "KES 1,501.00" },
      {
        label: "Claimed",
        value: "KES 1,500.50, rounded up to a whole shilling for M-Pesa",
      },
      { label: "Paid to", value: "Jane Wanjiku, M-Pesa ending 5678" },
      { label: "USDC", value: "11.664594 USDC" },
      { label: "Cash-out fee, at most", value: "0.308918 USDC" },
      { label: "Total, at most", value: "11.973512 USDC" },
    ]);
  });

  it("leaves out the claimed amount when nothing was rounded", () => {
    // #when
    const labels = previewRows({
      ...PREVIEW,
      claimedKes: "150100",
    }).map((row) => row.label);

    // #then
    expect(labels).not.toContain("Claimed");
  });
});

describe("topUpFrom", () => {
  it("asks for the top-up the API worked out", () => {
    // #given
    const error = new ApiError(409, "Conflict", "The wallet is too short.", {
      shortfallUsdc: "2000000",
      topUpKes: "25800",
    });

    // #when
    const message = topUpFrom(error);

    // #then
    expect(message).toBe(
      "Top up KES 258.00, then approve again. Nothing was sent.",
    );
  });

  it.each([
    ["a 409 without details", new ApiError(409, "Conflict", "Paused")],
    [
      "another status",
      new ApiError(400, "BadRequest", "Bad", { topUpKes: "25800" }),
    ],
    ["a network failure", new TypeError("Network request failed")],
  ])("is null for %s", (_case, error) => {
    // #when
    const message = topUpFrom(error);

    // #then
    expect(message).toBeNull();
  });
});

describe("describePaymentResult", () => {
  it.each([
    [result(["paying", "paying", null]), "sent"],
    [result(["paid", "paid", null]), "paid"],
    [result(["payout_failed", "failed", "Paycrest refused"]), "failed"],
    [result(["paying", "needs_review", null]), "review"],
    [
      result(["paying", "paying", null], ["payout_failed", "failed", "No"]),
      "failed",
    ],
    [
      result(
        ["payout_failed", "failed", "No"],
        ["paying", "needs_review", null],
      ),
      "review",
    ],
  ])("reads %j as %s", (paymentResult, expected) => {
    // #when
    const { outcome } = describePaymentResult(paymentResult);

    // #then
    expect(outcome).toBe(expected);
  });

  it("carries the failure's reason for the admin", () => {
    // #when
    const summary = describePaymentResult(
      result(["payout_failed", "failed", "Paycrest refused the order."]),
    );

    // #then
    expect(summary).toMatchObject({
      title: "The payment failed",
      failureReason: "Paycrest refused the order.",
    });
  });
});
