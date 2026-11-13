import { describe, expect, it } from "vitest";

import type { CashObligation, SpendingOverview } from "../overview.js";
import {
  cashCardBillsLine,
  cashFootnote,
  obligationAction,
  spendingOverviewSchema,
} from "../overview.js";

const cash: SpendingOverview["cash"] = {
  today: "2026-11-02",
  through: "2026-12-02",
  totalKes: "1286800",
  unknownAmounts: 0,
  obligations: [],
  balanceUsdc: "100000000",
  reservedUsdc: "0",
  balanceKes: "1286800",
  availableKes: "1286800",
  rate: "128.68",
  status: "covered",
  shortKes: "0",
  outsideKes: "0",
};

const obligation: CashObligation = {
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
};

describe("cashFootnote", () => {
  it("says what isn't counted without naming a cash-out provider", () => {
    // #when
    const footnote = cashFootnote(cash);

    // #then
    expect(footnote).toBe(
      "KES 12,868.00 to pay through Expendi by 2026-12-02, overdue included. Cash-out fees and bills paid outside Expendi aren't counted.",
    );
  });
});

describe("the cash check's card-paid bills", () => {
  it("reads a cash check from an API built before company-held cards as none", () => {
    // #when
    const parsed = spendingOverviewSchema.shape.cash.parse(cash);

    // #then
    expect(parsed.cardBills).toBeUndefined();
    expect(cashCardBillsLine(parsed)).toBeNull();
  });

  it("refuses a negative amount due, but not a Card balance spent past zero", () => {
    // #when
    const due = spendingOverviewSchema.shape.cash.safeParse({
      ...cash,
      cardBills: { dueUsdCents: "-1", availableUsdCents: "0", short: false },
    });
    const overspent = spendingOverviewSchema.shape.cash.safeParse({
      ...cash,
      cardBills: {
        dueUsdCents: "4000",
        availableUsdCents: "-250",
        short: true,
      },
    });

    // #then
    expect(due.success).toBe(false);
    expect(overspent.success).toBe(true);
  });

  it("says what's due by card against the Card balance", () => {
    // #when
    const covered = cashCardBillsLine({
      ...cash,
      cardBills: {
        dueUsdCents: "4000",
        availableUsdCents: "12000",
        short: false,
      },
    });
    const short = cashCardBillsLine({
      ...cash,
      cardBills: {
        dueUsdCents: "4000",
        availableUsdCents: "-250",
        short: true,
      },
    });

    // #then
    expect(covered).toBe(
      "Due by company-held card: USD 40.00 of USD 120.00 on the Card balance",
    );
    expect(short).toBe(
      "Card balance short: USD 40.00 due by company-held card, USD 0.00 left on it",
    );
  });
});

describe("obligationAction", () => {
  it("offers only a view of a bill a company-held card pays", () => {
    // #when
    const byCard = obligationAction({
      ...obligation,
      card: { id: "card-1", nickname: "Software", lastFour: "1881" },
    });
    const outside = obligationAction(obligation);

    // #then
    expect(byCard).toBe("View");
    expect(outside).toBe("Mark paid");
  });
});
