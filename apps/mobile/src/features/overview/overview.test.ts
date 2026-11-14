import { describe, expect, it } from "vitest";

import type {
  CashObligation,
  FloatSummary,
  SpendingOverview,
} from "@expendi-business/shared";

import {
  cashCardLine,
  cashExplanation,
  cashFigure,
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  kesCentsToUsdcCents,
  obligationAction,
  obligationAmount,
  obligationPaidBy,
  obligationTarget,
  openFloatLeft,
  shiftMonth,
} from "./overview-display";

const ID = "11111111-1111-4111-8111-111111111111";

function cash(
  overrides: Partial<SpendingOverview["cash"]> = {},
): SpendingOverview["cash"] {
  return {
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
    ...overrides,
  };
}

function obligation(overrides: Partial<CashObligation> = {}): CashObligation {
  return {
    id: ID,
    kind: "bill",
    name: "Kenya Power",
    notes: null,
    schedule: null,
    people: null,
    dueOn: "2026-11-09",
    amountKes: "450000",
    status: "upcoming",
    payVia: "expendi",
    needsAmount: false,
    heading: "transactions",
    ...overrides,
  };
}

/**
 * A bill a company-held card pays, as the API sends it: `outside` for apps
 * built before cards, its USD 20.00 estimate in US cents and in KES at
 * today's rate.
 */
function cardObligation(
  overrides: Partial<CashObligation> = {},
): CashObligation {
  return obligation({
    name: "Vercel",
    amountKes: "257360",
    payVia: "outside",
    heading: "subscriptions",
    card: { id: "card-1", nickname: "Software", lastFour: "1234" },
    amountUsdCents: "2000",
    ...overrides,
  });
}

describe("cash check", () => {
  it("says Covered, Short by the shortfall, or that it needs the rate", () => {
    // #when
    const headlines = [
      cashHeadline(cash()),
      cashHeadline(cash({ status: "short", shortKes: "12345" })),
      cashHeadline(cash({ status: "unknown", shortKes: null, rate: null })),
    ];

    // #then
    expect(headlines).toEqual([
      "Covered",
      "Short by KES 123.45",
      "Can't check without today's KES rate",
    ]);
  });

  it("mentions payments with no amount only when there are some", () => {
    // #when
    const none = cashFootnote(cash());
    const two = cashFootnote(cash({ unknownAmounts: 2 }));

    // #then
    expect(none).not.toContain("no amount");
    expect(two).toContain("Not counting 2 payments with no amount yet.");
  });

  it("mentions what's due outside Expendi only when something is", () => {
    // #when
    const lines = [
      cashOutsideLine(cash()),
      cashOutsideLine(cash({ outsideKes: "300000" })),
    ];

    // #then
    expect(lines).toEqual([null, "Also due outside Expendi: KES 3,000.00"]);
  });

  it("sets the bills company-held cards pay against the Card balance, only when there are some", () => {
    // #when
    const lines = [
      cashCardLine(cash()),
      cashCardLine(cash({ cardBills: null })),
      cashCardLine(
        cash({
          cardBills: {
            dueUsdCents: "4500",
            availableUsdCents: "12000",
            short: false,
          },
        }),
      ),
    ];

    // #then
    expect(lines).toEqual([
      null,
      null,
      {
        text: "Due by company-held card: USD 45.00 of USD 120.00 on the Card balance",
        short: false,
      },
    ]);
  });

  it("says when the Card balance won't cover them, overspent included, and where to load it", () => {
    // #when
    const line = cashCardLine(
      cash({
        cardBills: {
          dueUsdCents: "4500",
          availableUsdCents: "-250",
          short: true,
        },
      }),
    );

    // #then
    expect(line).toEqual({
      text: "Card balance short: USD 45.00 due by company-held card, USD 0.00 left on it. Load the Card balance on the web dashboard.",
      short: true,
    });
  });

  it("leaves a bill a company-held card pays out of what's due through or outside Expendi", () => {
    // #given
    const withCardBill = cash({
      totalKes: "0",
      outsideKes: "0",
      obligations: [cardObligation()],
      cardBills: {
        dueUsdCents: "2000",
        availableUsdCents: "5000",
        short: false,
      },
    });

    // #then
    expect({
      footnote: cashFootnote(withCardBill),
      outside: cashOutsideLine(withCardBill),
      card: cashCardLine(withCardBill)?.text,
    }).toEqual({
      footnote:
        "KES 0.00 to pay through Expendi by 2026-12-02, overdue included. Cash-out fees and bills paid outside Expendi aren't counted.",
      outside: null,
      card: "Due by company-held card: USD 20.00 of USD 50.00 on the Card balance",
    });
  });
});

describe("what's due next", () => {
  it("opens a bill, a payroll run, a recurring payment or the salaries", () => {
    // #when
    const targets = [
      obligationTarget(obligation()),
      obligationTarget(obligation({ kind: "payroll", heading: "salaries" })),
      obligationTarget(obligation({ kind: "forecast" })),
      obligationTarget(obligation({ kind: "forecast", heading: "salaries" })),
    ];

    // #then
    expect(targets).toEqual([
      { screen: "bill", billId: ID },
      { screen: "payroll_run", runId: ID },
      { screen: "recurring_item", itemId: ID },
      { screen: "salaries" },
    ]);
  });

  it("offers Pay only on what Expendi can pay now", () => {
    // #when
    const actions = [
      obligationAction(obligation()),
      obligationAction(obligation({ needsAmount: true, amountKes: null })),
      obligationAction(obligation({ payVia: "outside" })),
      obligationAction(obligation({ kind: "forecast", status: "forecast" })),
    ];

    // #then
    expect(actions).toEqual(["Pay", "Enter amount", "Mark paid", "View"]);
  });

  it("shows a missing amount as not entered, or unknown without a rate", () => {
    // #then
    expect([
      obligationAmount(obligation()),
      obligationAmount(obligation({ amountKes: null, needsAmount: true })),
      obligationAmount(obligation({ amountKes: null })),
    ]).toEqual(["KES 4,500.00", "Amount not entered", "Amount unknown"]);
  });

  it("says how each is paid, a company-held card's as automatic with its last four", () => {
    // #then
    expect([
      obligationPaidBy(obligation()),
      obligationPaidBy(obligation({ payVia: "outside" })),
      obligationPaidBy(cardObligation()),
      obligationPaidBy(
        cardObligation({ kind: "forecast", status: "forecast" }),
      ),
    ]).toEqual([
      "Through Expendi",
      "Paid outside Expendi",
      "Automatic · card •••• 1234",
      "Automatic · card •••• 1234",
    ]);
  });

  it("reads a company-held card's amount as its USD estimate, never as a KES amount to pay", () => {
    // #then
    expect([
      obligationAmount(cardObligation()),
      obligationAmount(cardObligation({ amountKes: null })),
      obligationAmount(
        cardObligation({ kind: "forecast", status: "forecast" }),
      ),
    ]).toEqual(["About USD 20.00", "About USD 20.00", "About USD 20.00"]);
  });

  it("says a company-held card's payment has no estimate, whether or not there's a rate", () => {
    // #then
    expect([
      obligationAmount(
        cardObligation({ amountUsdCents: null, amountKes: null }),
      ),
      obligationAmount(
        cardObligation({ amountUsdCents: undefined, amountKes: null }),
      ),
    ]).toEqual(["No estimate", "No estimate"]);
  });

  it("offers View on a company-held card's bill, never Mark paid, and opens the bill", () => {
    // #given
    const row = cardObligation();

    // #then
    expect({
      action: obligationAction(row),
      forecast: obligationAction(
        cardObligation({ kind: "forecast", status: "forecast" }),
      ),
      target: obligationTarget(row),
    }).toEqual({
      action: "View",
      forecast: "View",
      target: { screen: "bill", billId: ID },
    });
  });
});

describe("month and float helpers", () => {
  it("steps across year ends", () => {
    // #then
    expect([shiftMonth("2026-01", -1), shiftMonth("2026-12", 1)]).toEqual([
      "2025-12",
      "2027-01",
    ]);
  });

  it("adds up what's left in open floats only, beyond safe-number precision", () => {
    // #given
    const floats = [
      { status: "open", leftKes: "9007199254740993" },
      { status: "open", leftKes: "7" },
      { status: "closed", leftKes: "500" },
    ] as const satisfies readonly Pick<FloatSummary, "status" | "leftKes">[];

    // #then
    expect(openFloatLeft(floats)).toBe("9007199254741000");
  });
});

describe("kesCentsToUsdcCents", () => {
  it("divides by the rate and rounds towards zero", () => {
    // #when
    const usdc = kesCentsToUsdcCents("12128282", "129.00");

    // #then
    expect(usdc).toBe("94017");
  });

  it("accepts a whole-number rate", () => {
    // #when
    const usdc = kesCentsToUsdcCents("12900", "129");

    // #then
    expect(usdc).toBe("100");
  });

  it.each(["", "abc", "0", "0.00", "-129"])(
    "is null for the unusable rate %j",
    (rate) => {
      // #when
      const usdc = kesCentsToUsdcCents("12900", rate);

      // #then
      expect(usdc).toBeNull();
    },
  );
});

describe("cashFigure", () => {
  it("shows what's available in KES when the cash is covered", () => {
    // #when
    const figure = cashFigure(cash({ availableKes: "12128282" }), "KES");

    // #then
    expect(figure).toEqual({
      label: "Available",
      code: "KES",
      value: "121,282.82",
    });
  });

  it("converts what's available to USDC at the overview's rate", () => {
    // #when
    const figure = cashFigure(
      cash({ availableKes: "12128282", rate: "129.00" }),
      "USDC",
    );

    // #then
    expect(figure).toEqual({
      label: "Available",
      code: "USDC",
      value: "940.17",
    });
  });

  it("shows the shortfall when the cash is short", () => {
    // #when
    const figure = cashFigure(
      cash({ status: "short", shortKes: "1500050", availableKes: "-1500050" }),
      "KES",
    );

    // #then
    expect(figure).toEqual({
      label: "Short by",
      code: "KES",
      value: "15,000.50",
    });
  });

  it("falls back to the wallet's USDC when today's rate is missing", () => {
    // #when
    const figure = cashFigure(
      cash({
        status: "unknown",
        rate: null,
        availableKes: null,
        balanceKes: null,
        balanceUsdc: "3412580000",
      }),
      "KES",
    );

    // #then
    expect(figure).toEqual({
      label: "In the wallet",
      code: "USDC",
      value: "3,412.58",
    });
  });
});

describe("cashExplanation", () => {
  it("uses a human date and counts payments with no amount", () => {
    // #when
    const text = cashExplanation(
      cash({ totalKes: "31894000", through: "2026-12-10", unknownAmounts: 1 }),
    );

    // #then
    expect(text).toBe(
      "KES 318,940.00 to pay through Expendi by 10 Dec, overdue included. Not counting 1 payment with no amount yet. Paycrest's fees and bills paid outside Expendi aren't counted.",
    );
  });
});
