import { describe, expect, it } from "vitest";

import { holdsSummary } from "./columns";

describe("holdsSummary", () => {
  it("pluralises payouts under review", () => {
    expect(holdsSummary({ payoutsInReview: 0, openSends: 0 })).toBe(
      "0 payouts under review",
    );
    expect(holdsSummary({ payoutsInReview: 1, openSends: 0 })).toBe(
      "1 payout under review",
    );
    expect(holdsSummary({ payoutsInReview: 2, openSends: 0 })).toBe(
      "2 payouts under review",
    );
  });

  it("adds the open company wallet sends when there are any", () => {
    expect(holdsSummary({ payoutsInReview: 1, openSends: 2 })).toBe(
      "1 payout under review · 2 open company wallet send",
    );
  });
});
