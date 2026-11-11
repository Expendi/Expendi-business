import { describe, expect, it } from "vitest";

import type { FloatDetail } from "@expendi-business/shared";

import { spendingRows } from "./my-petty-cash-rows";

function floatWithLoneClaim(
  status: FloatDetail["overspendClaims"][number]["status"],
): FloatDetail {
  return {
    id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a40",
    status: "open",
    holder: {
      membershipId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a41",
      name: "Brian Otieno",
      email: "brian@mawingulabs.co.ke",
    },
    yours: true,
    openedAt: "2026-11-02T08:00:00.000Z",
    closedAt: null,
    issuedKes: "500000",
    spentKes: "500000",
    returnedKes: "0",
    writtenOffKes: "0",
    leftKes: "0",
    onTheWayKes: "0",
    awaitingApprovalKes: "0",
    spendingCount: 0,
    noReceiptCount: 0,
    movements: [],
    spending: [],
    overspendClaims: [
      {
        id: "2b1e5c7a-9d3f-4e8a-b6c1-0f2d3e4a5b6c",
        amountKes: "124000",
        status,
        merchant: "Kahawa Corner",
        spentOn: "2026-11-04",
      },
    ],
  };
}

describe("spendingRows", () => {
  it("says what happened to a reimbursement with no spending line", () => {
    // #given
    const float = floatWithLoneClaim("rejected");

    // #when
    const [row] = spendingRows(float, "2026-11-11");

    // #then
    expect(row).toMatchObject({
      meta: "Wed 4 Nov · Sent as a reimbursement, nothing was left · Returned",
      metaTone: "negative",
    });
  });

  it("marks a paid one as positive", () => {
    // #given
    const float = floatWithLoneClaim("paid");

    // #when
    const [row] = spendingRows(float, "2026-11-11");

    // #then
    expect(row?.metaTone).toBe("positive");
  });
});
