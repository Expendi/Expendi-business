import { describe, expect, it } from "vitest";

import {
  canFreeze,
  canShowDetails,
  cardFaceNumber,
  cardStateNotice,
  declineNotice,
  limitLeft,
  limitUsed,
  maskedCardNumber,
  merchantKind,
  purchaseAmount,
  purchaseBadges,
  purchaseDate,
  purchaseKes,
  purchaseMeta,
  purchaseShortDate,
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

describe("the monthly limit", () => {
  it("fills the meter by how much is spent", () => {
    // #when
    const used = limitUsed({
      spentThisMonthUsdCents: "41250",
      monthlyLimitUsdCents: "150000",
    });

    // #then
    expect(used).toBe(0.275);
  });

  it.each([
    ["over the limit", "160000", "150000"],
    ["a zero limit", "0", "0"],
  ])("shows a full meter on %s", (_case, spent, limit) => {
    // #when
    const used = limitUsed({
      spentThisMonthUsdCents: spent,
      monthlyLimitUsdCents: limit,
    });

    // #then
    expect(used).toBe(1);
  });

  it("says what's left this month", () => {
    // #when
    const left = limitLeft({
      spentThisMonthUsdCents: "41250",
      monthlyLimitUsdCents: "150000",
    });

    // #then
    expect(left).toBe("USD 1,087.50 left");
  });

  it("never says less than nothing is left", () => {
    // #when
    const left = limitLeft({
      spentThisMonthUsdCents: "160000",
      monthlyLimitUsdCents: "150000",
    });

    // #then
    expect(left).toBe("USD 0.00 left");
  });
});

describe("cardFaceNumber", () => {
  it("masks every group but the last four", () => {
    expect(cardFaceNumber("4821")).toBe("••••  ••••  ••••  4821");
  });
});

describe("purchaseMeta", () => {
  const now = new Date("2026-11-14T08:00:00.000Z");
  const purchase = {
    authorizedAt: "2026-11-12T16:20:00.000Z",
    kind: "purchase",
    status: "settled",
    needsReceipt: false,
  } as const;

  it("is just the day for a settled purchase with its receipt", () => {
    expect(purchaseMeta(purchase, now)).toBe("12 Nov");
  });

  it("asks for the receipt", () => {
    expect(purchaseMeta({ ...purchase, needsReceipt: true }, now)).toBe(
      "12 Nov · Receipt needed",
    );
  });

  it("says when it's still pending", () => {
    expect(
      purchaseMeta({ ...purchase, status: "pending", needsReceipt: true }, now),
    ).toBe("12 Nov · Pending · Receipt needed");
  });

  it("says a decline", () => {
    expect(purchaseMeta({ ...purchase, status: "declined" }, now)).toBe(
      "12 Nov · Declined",
    );
  });

  it("calls a refund a refund", () => {
    expect(purchaseMeta({ ...purchase, kind: "refund" }, now)).toBe(
      "12 Nov · Refund",
    );
  });
});

describe("purchaseShortDate", () => {
  const now = new Date("2026-01-02T08:00:00.000Z");

  it("leaves out this year", () => {
    expect(purchaseShortDate("2026-01-01T09:00:00.000Z", now)).toBe("1 Jan");
  });

  it("keeps the year of an older purchase, by the day in Nairobi", () => {
    // #given 22:30 UTC on 31 Dec is already 1 Jan in Nairobi
    expect(purchaseShortDate("2025-12-31T20:30:00.000Z", now)).toBe(
      "31 Dec 2025",
    );
    expect(purchaseShortDate("2025-12-31T22:30:00.000Z", now)).toBe("1 Jan");
  });
});

describe("merchantKind", () => {
  it.each([
    ["4511", "flight"],
    ["3058", "flight"],
    ["7011", "stay"],
    ["3502", "stay"],
    ["4121", "ride"],
    ["5541", "fuel"],
    ["5812", "food"],
    ["5734", "other"],
  ] as const)("reads MCC %s as %s", (mcc, kind) => {
    expect(merchantKind(mcc)).toBe(kind);
  });
});
