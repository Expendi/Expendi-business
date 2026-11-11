import { describe, expect, it } from "vitest";

import type {
  CashObligation,
  FloatSummary,
  SpendingOverview,
} from "@expendi-business/shared";

import {
  cashExplanation,
  cashFigure,
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAction,
  obligationAmount,
  kesCentsToUsdcCents,
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
    expect(figure).toEqual({ label: "Available", code: "USDC", value: "940.17" });
  });

  it("shows the shortfall when the cash is short", () => {
    // #when
    const figure = cashFigure(
      cash({ status: "short", shortKes: "1500050", availableKes: "-1500050" }),
      "KES",
    );

    // #then
    expect(figure).toEqual({ label: "Short by", code: "KES", value: "15,000.50" });
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
