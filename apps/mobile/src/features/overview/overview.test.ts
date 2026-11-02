import { describe, expect, it } from "vitest";

import type {
  CashObligation,
  FloatSummary,
  SpendingOverview,
} from "@expendi-business/shared";

import {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAction,
  obligationAmount,
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
