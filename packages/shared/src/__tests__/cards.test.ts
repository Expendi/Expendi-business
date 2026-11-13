import { describe, expect, it } from "vitest";

import {
  cardActionSchema,
  formatUsdCents,
  listCardPurchasesQuerySchema,
  listCardsQuerySchema,
  reviewCardPurchaseRequestSchema,
} from "../cards.js";
import { runCardSimulationRequestSchema } from "../internal-ops.js";

const recurringItemId = "11111111-1111-4111-8111-111111111111";

describe("formatUsdCents", () => {
  it("formats whole dollars and cents", () => {
    expect(formatUsdCents(150050n)).toBe("USD 1,500.50");
    expect(formatUsdCents(0n)).toBe("USD 0.00");
  });

  it("keeps the sign on a Card balance a late clearing took below zero", () => {
    expect(formatUsdCents(-50n)).toBe("-USD 0.50");
  });
});

describe("cardActionSchema", () => {
  it("issues a company-held card with no cardholder", () => {
    // #when
    const parsed = cardActionSchema.parse({
      type: "issue_company_card",
      nickname: " Software ",
      monthlyLimitUsd: "250",
      defaultCategoryId: "22222222-2222-4222-8222-222222222222",
    });

    // #then
    expect(parsed).toEqual({
      type: "issue_company_card",
      nickname: "Software",
      monthlyLimitUsd: 25_000n,
      defaultCategoryId: "22222222-2222-4222-8222-222222222222",
    });
  });
});

describe("reviewCardPurchaseRequestSchema", () => {
  it.each([
    [{ decision: "link", recurringItemId }],
    [{ decision: "one_off" }],
    [{ decision: "not_recognised" }],
  ] as const)("takes %o", (request) => {
    // #then
    expect(reviewCardPurchaseRequestSchema.parse(request)).toEqual(request);
  });

  it("needs the recurring payment a purchase is linked to", () => {
    // #when
    const parsed = reviewCardPurchaseRequestSchema.safeParse({
      decision: "link",
    });

    // #then
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["recurringItemId"],
        message: "Pick the recurring payment it pays.",
      }),
    ]);
  });

  it("refuses a decision it doesn't know", () => {
    // #when
    const parsed = reviewCardPurchaseRequestSchema.safeParse({
      decision: "ignore",
    });

    // #then
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        message:
          "Say whether it's one of the card's recurring payments, a one-off, or not recognised.",
      }),
    ]);
  });
});

describe("list filters", () => {
  it("reads companyHeld on the cards list", () => {
    // #then
    expect(listCardsQuerySchema.parse({ companyHeld: "true" })).toEqual({
      companyHeld: true,
    });
    expect(listCardsQuerySchema.safeParse({ companyHeld: "yes" }).success).toBe(
      false,
    );
  });

  it("reads needsReview on the purchases list", () => {
    // #then
    expect(
      listCardPurchasesQuerySchema.parse({ needsReview: "false" }),
    ).toMatchObject({ needsReview: false });
  });
});

describe("runCardSimulationRequestSchema", () => {
  it("takes another amount, in US cents, and a new merchant", () => {
    // #then
    expect(
      runCardSimulationRequestSchema.parse({
        recurringItemId,
        amountUsd: "24.50",
        newMerchant: true,
      }),
    ).toEqual({ recurringItemId, amountUsd: 2_450n, newMerchant: true });
  });

  it("refuses an amount of nothing", () => {
    // #then
    expect(
      runCardSimulationRequestSchema.safeParse({
        recurringItemId,
        amountUsd: "0",
      }).success,
    ).toBe(false);
  });
});
