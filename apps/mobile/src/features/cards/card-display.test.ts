import { describe, expect, it } from "vitest";

import {
  canFreeze,
  canShowDetails,
  cardStateNotice,
  declineNotice,
  maskedCardNumber,
  purchaseAmount,
  purchaseBadges,
  purchaseDate,
  purchaseKes,
  receiptSummary,
  spentOfLimit,
} from "./card-display";

describe("card facts", () => {
  it("masks the number down to its last four", () => {
    expect(maskedCardNumber("1234")).toBe("•••• 1234");
  });

  it("shows what's been spent against the limit", () => {
    // #when
    const line = spentOfLimit({
      spentThisMonthUsdCents: "12050",
      monthlyLimitUsdCents: "50000",
    });

    // #then
    expect(line).toBe("USD 120.50 of USD 500.00 this month");
  });
});

describe("what a holder can do", () => {
  it.each([
    ["open", true, true],
    ["frozen", false, true],
    ["closed", false, false],
  ] as const)("on a card that's %s", (state, freeze, show) => {
    // #when
    const card = { state, yours: true };

    // #then
    expect(canFreeze(card)).toBe(freeze);
    expect(canShowDetails(card)).toBe(show);
  });

  it("offers nothing on someone else's card", () => {
    // #when
    const card = { state: "open", yours: false } as const;

    // #then
    expect(canFreeze(card)).toBe(false);
    expect(canShowDetails(card)).toBe(false);
  });

  it("says only an admin can unfreeze a frozen card", () => {
    expect(cardStateNotice("frozen")).toContain("Only an admin");
  });

  it("says nothing about an open card", () => {
    expect(cardStateNotice("open")).toBeNull();
  });
});

describe("purchaseAmount", () => {
  const spend = { kind: "purchase", holdUsdCents: "0" } as const;

  it("counts what's settled and what's still held on a split clearing", () => {
    // #when
    const amount = purchaseAmount({
      ...spend,
      settledUsdCents: "700",
      holdUsdCents: "300",
    });

    // #then
    expect(amount).toBe("USD 10.00");
  });

  it("marks a refund as money coming back", () => {
    // #when
    const amount = purchaseAmount({
      kind: "refund",
      settledUsdCents: "1250",
      holdUsdCents: "0",
    });

    // #then
    expect(amount).toBe("+USD 12.50");
  });

  it("has no amount when nothing was ever held", () => {
    expect(purchaseAmount({ ...spend, settledUsdCents: "0" })).toBeNull();
  });
});

describe("purchaseKes", () => {
  it("shows KES once it's recorded", () => {
    expect(purchaseKes({ amountKes: "128680" })).toBe("KES 1,286.80");
  });

  it("shows nothing before that", () => {
    expect(purchaseKes({ amountKes: null })).toBeNull();
  });
});

describe("purchaseBadges", () => {
  it("asks for a receipt on a spend that needs one", () => {
    // #when
    const badges = purchaseBadges({
      kind: "purchase",
      status: "pending",
      needsReceipt: true,
    });

    // #then
    expect(badges.map(({ label }) => label)).toEqual([
      "Pending",
      "Receipt needed",
    ]);
  });

  it("makes a settled refund look like a refund, not a spend", () => {
    // #when
    const badges = purchaseBadges({
      kind: "refund",
      status: "settled",
      needsReceipt: false,
    });

    // #then
    expect(badges.map(({ label }) => label)).toEqual(["Refund"]);
  });

  it("keeps a refund's status until it settles", () => {
    // #when
    const badges = purchaseBadges({
      kind: "refund",
      status: "pending",
      needsReceipt: false,
    });

    // #then
    expect(badges.map(({ label }) => label)).toEqual(["Refund", "Pending"]);
  });
});

describe("declineNotice", () => {
  it("gives the reason for a decline", () => {
    // #when
    const notice = declineNotice({
      status: "declined",
      declineReason: "Not enough in the Card balance.",
    });

    // #then
    expect(notice).toBe("Not enough in the Card balance.");
  });

  it("still says it was declined when no reason came", () => {
    // #when
    const notice = declineNotice({ status: "declined", declineReason: null });

    // #then
    expect(notice).toBe("This purchase was declined.");
  });

  it("says nothing about a purchase that went through", () => {
    // #when
    const notice = declineNotice({ status: "settled", declineReason: null });

    // #then
    expect(notice).toBeNull();
  });
});

describe("receiptSummary", () => {
  const none = { receiptCount: 0, noReceiptReason: null, needsReceipt: false };

  it.each([
    [{ ...none, receiptCount: 1 }, "1 receipt added"],
    [{ ...none, receiptCount: 2 }, "2 receipts added"],
    [{ ...none, needsReceipt: true }, "Still needed"],
    [
      { ...none, noReceiptReason: "Lost at the airport" },
      "Not needed: Lost at the airport",
    ],
  ])("describes %j", (purchase, summary) => {
    expect(receiptSummary(purchase)).toBe(summary);
  });

  it("is silent where a receipt doesn't apply", () => {
    expect(receiptSummary(none)).toBeNull();
  });
});

describe("purchaseDate", () => {
  it("uses the day it was in Nairobi", () => {
    // #when
    const date = purchaseDate("2026-11-08T22:30:00.000Z");

    // #then
    expect(date).toBe("9 Nov 2026");
  });
});
