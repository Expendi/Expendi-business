import { describe, expect, it } from "vitest";

import type { OverviewPayment, SpendingOverview } from "@expendi-business/shared";

import {
  categoriesSpent,
  comparisonLine,
  filterOf,
  filterPayments,
  headingBars,
  monthChoices,
  monthName,
  paymentMeta,
  spentLabel,
} from "./expenses-display";

function payment(overrides: Partial<OverviewPayment>): OverviewPayment {
  return {
    id: "p1",
    subjectId: "s1",
    kind: "company",
    name: "Google Workspace",
    date: "2026-11-05",
    amountKes: "602000",
    heading: "subscriptions",
    categoryId: "c1",
    categoryName: "Software",
    personId: null,
    channel: "outside",
    ...overrides,
  };
}

function overview(overrides: Partial<SpendingOverview> = {}): SpendingOverview {
  return {
    month: "2026-11",
    previousMonth: "2026-10",
    currentKes: "1000000",
    previousKes: "7350840",
    headings: [
      { id: "transactions", name: "Transactions", currentKes: "750000", previousKes: "0" },
      { id: "salaries", name: "Salaries & personnel", currentKes: "0", previousKes: "0" },
    ],
    categories: [
      { id: "a", name: "Travel", currentKes: "100", previousKes: "5" },
      { id: "b", name: "Meals", currentKes: "300", previousKes: "0" },
      { id: "c", name: "Rent", currentKes: "0", previousKes: "900" },
    ],
    recentPayments: [],
    outstanding: { overdue: [], dueToday: [], claims: [], noReceipt: [] },
    cash: {
      today: "2026-11-11",
      through: "2026-12-10",
      totalKes: "0",
      unknownAmounts: 0,
      obligations: [
        { id: "r1", kind: "payroll", name: "Payroll", dueOn: "2026-11-28", amountKes: "1", status: "scheduled", payVia: "expendi", needsAmount: false, heading: "salaries" },
      ],
      balanceUsdc: "0",
      reservedUsdc: "0",
      balanceKes: null,
      availableKes: null,
      rate: null,
      status: "unknown",
      shortKes: null,
      outsideKes: "0",
    },
    people: [{ id: "u1", name: "Brian Otieno" }],
    ...overrides,
  };
}

describe("monthChoices", () => {
  it("lists this month first as the empty value, then 11 earlier months across years", () => {
    // #when
    const choices = monthChoices("2026-02");

    // #then
    expect(choices).toHaveLength(12);
    expect(choices[0]).toEqual({ value: "", label: "February" });
    expect(choices[1]).toEqual({ value: "2026-01", label: "January" });
    expect(choices[2]).toEqual({ value: "2025-12", label: "December 2025" });
  });

  it("never shows the machine month", () => {
    expect(monthName("2026-10", "2026-11")).toBe("October");
    expect(monthName("nonsense", "2026-11")).toBe("nonsense");
  });
});

describe("month wording", () => {
  it("shows the day range and last month in full for the current month", () => {
    expect(spentLabel(overview())).toBe("Spent this month");
    expect(comparisonLine(overview())).toBe("1–11 Nov · October in full: 73,508.40");
  });

  it("shows a single day on the first of the month", () => {
    // #given
    const first = overview();
    first.cash.today = "2026-11-01";

    // #then
    expect(comparisonLine(first)).toBe("1 Nov · October in full: 73,508.40");
  });

  it("names a past month and leaves out the day range", () => {
    // #given
    const past = overview({ month: "2026-09", previousMonth: "2026-08", previousKes: "100" });

    // #then
    expect(spentLabel(past)).toBe("Spent in September");
    expect(comparisonLine(past)).toBe("August in full: 1.00");
  });
});

describe("headingBars", () => {
  it("sizes each bar by its share of the month", () => {
    // #when
    const [transactions] = headingBars(overview());

    // #then
    expect(transactions?.permille).toBe(750);
    expect(transactions?.amount).toBe("7,500.00");
  });

  it("draws empty bars, not NaN, when nothing was spent", () => {
    // #given
    const none = overview({
      currentKes: "0",
      headings: [{ id: "transactions", name: "Transactions", currentKes: "0", previousKes: "0" }],
    });

    // #then
    expect(headingBars(none)[0]?.permille).toBe(0);
  });

  it("says when payroll runs for a salaries heading still at zero", () => {
    // #then
    expect(headingBars(overview())[1]?.note).toBe("Payroll runs Sat 28 Nov");
    expect(headingBars(overview())[0]?.note).toBeNull();
  });

  it("gives no payroll note for a past month", () => {
    // #given
    const past = overview({ month: "2026-09" });

    // #then
    expect(headingBars(past)[1]?.note).toBeNull();
  });
});

describe("categoriesSpent", () => {
  it("drops categories with no spending this month and puts the biggest first", () => {
    // #then
    expect(categoriesSpent(overview()).map((row) => row.name)).toEqual(["Meals", "Travel"]);
  });
});

describe("filters", () => {
  it("maps each payment kind to one filter", () => {
    expect(filterOf("claim")).toBe("reimbursements");
    expect(filterOf("float")).toBe("petty_cash");
    expect(filterOf("company")).toBe("company");
    expect(filterOf("bill")).toBe("company");
  });

  it("keeps everything for All and only the matching kinds otherwise", () => {
    // #given
    const rows = [
      payment({ id: "1", kind: "claim" }),
      payment({ id: "2", kind: "float" }),
      payment({ id: "3", kind: "company" }),
      payment({ id: "4", kind: "bill" }),
    ];

    // #then
    expect(filterPayments(rows, "all")).toHaveLength(4);
    expect(filterPayments(rows, "company").map((row) => row.id)).toEqual(["3", "4"]);
    expect(filterPayments(rows, "reimbursements").map((row) => row.id)).toEqual(["1"]);
  });
});

describe("paymentMeta", () => {
  it("names the person, the kind and a human date", () => {
    // #when
    const meta = paymentMeta(payment({ kind: "claim", personId: "u1", date: "2026-11-06" }), overview());

    // #then
    expect(meta).toEqual({ text: "Brian Otieno · reimbursement · Fri 6 Nov", noReceipt: false });
  });

  it("starts with the kind when nobody is named", () => {
    expect(paymentMeta(payment({}), overview()).text).toBe("Company · Thu 5 Nov");
  });

  it("flags petty cash the overview lists as missing a receipt", () => {
    // #given
    const data = overview({
      outstanding: { overdue: [], dueToday: [], claims: [], noReceipt: [{ id: "p1", name: "Fuel", amountKes: "1", floatId: null }] },
    });

    // #when
    const meta = paymentMeta(payment({ kind: "float", personId: "u1" }), data);

    // #then
    expect(meta.noReceipt).toBe(true);
    expect(meta.text).toBe("Brian Otieno · petty cash · Thu 5 Nov · no receipt");
  });
});
