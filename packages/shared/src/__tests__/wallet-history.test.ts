import { describe, expect, it } from "vitest";

import { walletHistoryPayoutSchema } from "../wallet-history.js";

const payout = {
  id: "00000000-0000-4000-8000-000000000001",
  subjectType: "bill",
  method: "mpesa_till",
  recipientName: "Kenya Power",
  recipientDetail: "Till 123456",
  recipientChain: null,
  amountKesCents: "250000",
  status: "paid",
  subjectId: "00000000-0000-4000-8000-000000000002",
  payrollRunId: null,
  approvalId: null,
  approvedAt: null,
  paidAt: null,
  categoryName: "Utilities",
  paymentReceipts: [],
  rate: null,
  failureReason: null,
};

describe("walletHistoryPayoutSchema", () => {
  it("carries the category of the bill a payout pays", () => {
    // #when
    const parsed = walletHistoryPayoutSchema.parse(payout);

    // #then
    expect(parsed.categoryName).toBe("Utilities");
  });

  it("accepts no category for anything that isn't a bill", () => {
    // #when
    const parsed = walletHistoryPayoutSchema.parse({
      ...payout,
      subjectType: "claim",
      categoryName: null,
    });

    // #then
    expect(parsed.categoryName).toBeNull();
  });

  it("refuses a payout that leaves the category out", () => {
    // #given
    const { categoryName: _categoryName, ...withoutCategory } = payout;

    // #when
    const result = walletHistoryPayoutSchema.safeParse(withoutCategory);

    // #then
    expect(result.success).toBe(false);
  });
});
