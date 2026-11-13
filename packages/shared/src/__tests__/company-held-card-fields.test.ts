import { describe, expect, it } from "vitest";

import type { SpendingOverview } from "../index.js";
import {
  billDetailSchema,
  billSchema,
  cashCardBillsLine,
  cashObligationSchema,
  obligationAction,
  recurringItemSchema,
} from "../index.js";

/**
 * Fields added for company-held cards after the first clients shipped:
 * each is read when sent and left out by an API built before it.
 */

const CARD = {
  id: "0b6f4c1e-8f7a-4a52-9a52-0c1d2e3f4a5b",
  nickname: "Software subscriptions",
  lastFour: "1881",
};

describe("a bill's card", () => {
  const card = billSchema.shape.card;

  it("says whether the card is open, frozen or closed", () => {
    expect(card.parse({ ...CARD, state: "frozen" })?.state).toBe("frozen");
    expect(card.safeParse({ ...CARD, state: "lost" }).success).toBe(false);
  });

  it("reads a card sent without its state", () => {
    expect(card.parse(CARD)?.state).toBeUndefined();
  });
});

describe("a bill's recurring payment", () => {
  const recurring = billSchema.shape.recurring;
  const item = {
    id: "5d0c2a9e-6b1f-4c8e-9a3d-7e2f1b0c4d5e",
    state: "ended",
    schedule: "monthly",
    scheduleDay: 11,
    startsOn: "2026-01-11",
  };

  it("says whether it's paused, apart from having ended", () => {
    expect(recurring.parse({ ...item, active: true })?.active).toBe(true);
    expect(recurring.parse({ ...item, active: false })?.active).toBe(false);
    expect(recurring.safeParse({ ...item, active: "no" }).success).toBe(false);
  });

  it("reads one sent without it", () => {
    expect(recurring.parse(item)?.active).toBeUndefined();
  });
});

describe("a bill's paidAmountKes", () => {
  const paidAmountKes = billDetailSchema.shape.paidAmountKes;

  it("is KES cents as digits, or null until paid", () => {
    expect(paidAmountKes.parse("277000")).toBe("277000");
    expect(paidAmountKes.parse(null)).toBeNull();
    expect(paidAmountKes.safeParse("-1").success).toBe(false);
  });

  it("is left out by an API built before it", () => {
    expect(paidAmountKes.parse(undefined)).toBeUndefined();
  });
});

describe("a recurring payment's nextBill", () => {
  const nextBill = recurringItemSchema.shape.nextBill;
  const bill = {
    id: "5d0c2a9e-6b1f-4c8e-9a3d-7e2f1b0c4d5e",
    status: "due",
    dueOn: "2026-11-11",
    currency: "usd",
    amountKes: null,
    amountUsdc: "20000000",
  };

  it("says when the card last declined a purchase meant for it", () => {
    expect(
      nextBill.parse({ ...bill, cardDeclinedAt: "2026-11-13T06:00:00.000Z" })
        ?.cardDeclinedAt,
    ).toBe("2026-11-13T06:00:00.000Z");
    expect(
      nextBill.parse({ ...bill, cardDeclinedAt: null })?.cardDeclinedAt,
    ).toBeNull();
  });

  it("reads a next bill sent without it", () => {
    expect(nextBill.parse(bill)?.cardDeclinedAt).toBeUndefined();
  });
});

describe("a cash check row a company-held card pays", () => {
  const row = {
    id: "bill-1",
    kind: "bill",
    name: "Anthropic",
    notes: null,
    schedule: "monthly",
    people: null,
    dueOn: "2026-11-05",
    amountKes: "258000",
    status: "upcoming",
    payVia: "outside",
    needsAmount: false,
    heading: "subscriptions",
    card: CARD,
  } as const;

  it("carries its estimate in US cents, or null without one", () => {
    expect(
      cashObligationSchema.parse({ ...row, amountUsdCents: "2000" })
        .amountUsdCents,
    ).toBe("2000");
    expect(
      cashObligationSchema.parse({ ...row, amountUsdCents: null })
        .amountUsdCents,
    ).toBeNull();
    expect(
      cashObligationSchema.safeParse({ ...row, amountUsdCents: "20.00" })
        .success,
    ).toBe(false);
  });

  it("reads a row sent without it", () => {
    expect(cashObligationSchema.parse(row).amountUsdCents).toBeUndefined();
  });

  it("is offered only as a view, and summed against the Card balance, from the package's index", () => {
    expect(obligationAction(cashObligationSchema.parse(row))).toBe("View");
    expect(
      cashCardBillsLine({
        today: "2026-11-02",
        through: "2026-12-02",
        totalKes: "0",
        unknownAmounts: 0,
        obligations: [],
        balanceUsdc: "0",
        reservedUsdc: "0",
        balanceKes: "0",
        availableKes: "0",
        rate: "128.68",
        status: "covered",
        shortKes: "0",
        outsideKes: "0",
        cardBills: {
          dueUsdCents: "2000",
          availableUsdCents: "5000",
          short: false,
        },
      } satisfies SpendingOverview["cash"]),
    ).toBe(
      "Due by company-held card: USD 20.00 of USD 50.00 on the Card balance",
    );
  });
});
