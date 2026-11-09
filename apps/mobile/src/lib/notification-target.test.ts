import { describe, expect, it } from "vitest";

import {
  notificationHref,
  notificationQueryKey,
  notificationTarget,
} from "./notification-target";

const ORGANIZATION_ID = "5b0f6a52-3d8e-4c1a-9f7e-2a4b6c8d0e1f";
const CLAIM_ID = "8c2d4e6f-1a3b-4c5d-8e7f-9a0b1c2d3e4f";
const CARD_ID = "7d1e3f5a-2b4c-4d6e-9f80-1a2b3c4d5e6f";
const PURCHASE_ID = "6e0f2a4b-3c5d-4e7f-8a91-2b3c4d5e6f70";

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
      kind: "claim",
      organizationId: ORGANIZATION_ID,
      claimId: CLAIM_ID,
    });
  });

  it.each([
    "card_receipt_needed",
    "card_receipt_reminder",
    "card_purchase_declined",
  ])("opens the purchase for %s", (type) => {
    // #when
    const target = notificationTarget({
      type,
      organizationId: ORGANIZATION_ID,
      cardId: CARD_ID,
      purchaseId: PURCHASE_ID,
    });

    // #then
    expect(target).toEqual({
      kind: "card_purchase",
      organizationId: ORGANIZATION_ID,
      purchaseId: PURCHASE_ID,
      cardId: CARD_ID,
    });
  });

  it("opens the card for card_issued", () => {
    // #when
    const target = notificationTarget({
      type: "card_issued",
      organizationId: ORGANIZATION_ID,
      cardId: CARD_ID,
    });

    // #then
    expect(target).toEqual({
      kind: "card",
      organizationId: ORGANIZATION_ID,
      cardId: CARD_ID,
    });
  });

  it("opens the cards screen for card_balance_low", () => {
    // #when
    const target = notificationTarget({
      type: "card_balance_low",
      organizationId: ORGANIZATION_ID,
    });

    // #then
    expect(target).toEqual({
      kind: "cards",
      organizationId: ORGANIZATION_ID,
    });
  });

  it("opens the cards screen for a refund, which goes to admins", () => {
    // #when
    const target = notificationTarget({
      type: "card_refund_received",
      organizationId: ORGANIZATION_ID,
      cardId: CARD_ID,
      purchaseId: PURCHASE_ID,
    });

    // #then
    expect(target).toEqual({
      kind: "cards",
      organizationId: ORGANIZATION_ID,
    });
  });

  it("falls back to the cards screen when a card push names nothing", () => {
    // #when
    const target = notificationTarget({
      type: "card_issued",
      organizationId: ORGANIZATION_ID,
    });

    // #then
    expect(target).toEqual({
      kind: "cards",
      organizationId: ORGANIZATION_ID,
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
    [
      "a purchase ID that isn't one",
      {
        type: "card_receipt_needed",
        organizationId: ORGANIZATION_ID,
        purchaseId: "../x",
      },
    ],
    ["a card push with no company", { type: "card_balance_low" }],
  ])("ignores %s", (_label, data) => {
    // #when
    const target = notificationTarget(data);

    // #then
    expect(target).toBeNull();
  });
});

describe("notificationHref", () => {
  it("opens a claim", () => {
    // #when
    const href = notificationHref({
      kind: "claim",
      organizationId: ORGANIZATION_ID,
      claimId: CLAIM_ID,
    });

    // #then
    expect(href).toEqual({
      pathname: "/claims/[claimId]",
      params: { claimId: CLAIM_ID },
    });
  });

  it("opens a purchase, naming its card so it's found quickly", () => {
    // #when
    const href = notificationHref({
      kind: "card_purchase",
      organizationId: ORGANIZATION_ID,
      purchaseId: PURCHASE_ID,
      cardId: CARD_ID,
    });

    // #then
    expect(href).toEqual({
      pathname: "/cards/purchases/[purchaseId]",
      params: { purchaseId: PURCHASE_ID, cardId: CARD_ID },
    });
  });

  it("opens a card", () => {
    // #when
    const href = notificationHref({
      kind: "card",
      organizationId: ORGANIZATION_ID,
      cardId: CARD_ID,
    });

    // #then
    expect(href).toEqual({
      pathname: "/cards/[cardId]",
      params: { cardId: CARD_ID },
    });
  });

  it("opens the cards screen", () => {
    expect(
      notificationHref({ kind: "cards", organizationId: ORGANIZATION_ID }),
    ).toBe("/cards");
  });
});

describe("notificationQueryKey", () => {
  it("refreshes claims for a claim", () => {
    // #when
    const key = notificationQueryKey({
      kind: "claim",
      organizationId: ORGANIZATION_ID,
      claimId: CLAIM_ID,
    });

    // #then
    expect(key).toEqual(["organizations", ORGANIZATION_ID, "claims"]);
  });

  it("refreshes cards for anything about a card", () => {
    // #when
    const key = notificationQueryKey({
      kind: "cards",
      organizationId: ORGANIZATION_ID,
    });

    // #then
    expect(key).toEqual(["organizations", ORGANIZATION_ID, "cards"]);
  });
});
