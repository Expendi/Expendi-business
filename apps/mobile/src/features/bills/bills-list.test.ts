import { describe, expect, it } from "vitest";

import type { Bill, BillStatus } from "@expendi-business/shared";

import {
  beingPaidBills,
  billWhen,
  overdueSummary,
  rowAmount,
  toPayBills,
  toPaySections,
  toPayTotal,
  totalExclusionNote,
  withoutPayrollBills,
} from "./bills-list";

let nextId = 0;

function bill(overrides: Partial<Bill> = {}): Bill {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    status: "upcoming",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Kenya Power",
      kind: "supplier",
      method: "mpesa_paybill",
      archived: false,
    },
    overviewHeading: "transactions",
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Utilities" },
    variable: false,
    currency: "kes",
    amountKes: "100000",
    amountUsdc: null,
    reference: null,
    notes: null,
    dueOn: "2026-11-20",
    recurringItemId: null,
    payrollRunId: null,
    adjustmentReason: null,
    paidOn: null,
    paidAt: null,
    markedPaidBy: null,
    paidOutsideNote: null,
    cancelledReason: null,
    cancelledAt: null,
    cancelledBy: null,
    payoutId: null,
    fileCount: 0,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

const TODAY = "2026-11-11";

describe("withoutPayrollBills", () => {
  it("drops bills that belong to a payroll run", () => {
    // #given
    const salary = bill({ payrollRunId: "33333333-3333-4333-8333-333333333333" });
    const rent = bill();

    // #when
    const kept = withoutPayrollBills([salary, rent]);

    // #then
    expect(kept).toEqual([rent]);
  });
});

describe("to pay and being paid", () => {
  it("keeps in-flight bills out of To pay", () => {
    // #given
    const bills = (["overdue", "paying", "upcoming"] as BillStatus[]).map(
      (status) => bill({ status }),
    );

    // #when / #then
    expect(toPayBills(bills).map((b) => b.status)).toEqual([
      "overdue",
      "upcoming",
    ]);
    expect(beingPaidBills(bills).map((b) => b.status)).toEqual(["paying"]);
  });
});

describe("toPaySections", () => {
  it("splits by urgency and drops empty sections", () => {
    // #given
    const bills = [
      bill({ status: "upcoming", dueOn: "2026-12-01" }),
      bill({ status: "overdue", dueOn: "2026-11-09" }),
      bill({ status: "due", dueOn: TODAY }),
      bill({ status: "upcoming", dueOn: "2026-11-18" }),
      bill({ status: "payout_failed", dueOn: "2026-11-05" }),
    ];

    // #when
    const sections = toPaySections(bills, TODAY);

    // #then
    expect(sections.map((s) => [s.title, s.bills.length])).toEqual([
      ["Overdue", 1],
      ["Payment failed", 1],
      ["This week", 2],
      ["Later", 1],
    ]);
  });

  it("returns nothing when there are no bills", () => {
    expect(toPaySections([], TODAY)).toEqual([]);
  });
});

describe("toPayTotal", () => {
  it("sums KES only and counts what it leaves out", () => {
    // #given
    const bills = [
      bill({ amountKes: "899900" }),
      bill({ amountKes: "100" }),
      bill({ currency: "usd", amountKes: null, amountUsdc: "120500000" }),
      bill({ variable: true, amountKes: null }),
      bill({ currency: "usd", variable: true, amountKes: null, amountUsdc: null }),
    ];

    // #when
    const total = toPayTotal(bills);

    // #then
    expect(total).toEqual({ kesCents: "900000", usdBills: 1, awaitingAmount: 2 });
  });

  it("is zero for no bills", () => {
    expect(toPayTotal([])).toEqual({ kesCents: "0", usdBills: 0, awaitingAmount: 0 });
  });
});

describe("totalExclusionNote", () => {
  it("says what is not counted", () => {
    expect(
      totalExclusionNote({ kesCents: "0", usdBills: 1, awaitingAmount: 2 }),
    ).toBe("Not counting 1 USD bill and 2 bills waiting for an amount.");
    expect(
      totalExclusionNote({ kesCents: "0", usdBills: 0, awaitingAmount: 1 }),
    ).toBe("Not counting 1 bill waiting for an amount.");
  });

  it("is null when everything is counted", () => {
    expect(
      totalExclusionNote({ kesCents: "5", usdBills: 0, awaitingAmount: 0 }),
    ).toBeNull();
  });
});

describe("overdueSummary", () => {
  it("shows the count and the KES owed", () => {
    // #given
    const bills = [
      bill({ status: "overdue", amountKes: "899900" }),
      bill({ status: "upcoming" }),
    ];

    // #then
    expect(overdueSummary(bills)).toBe("1 overdue · 8,999.00");
  });

  it("shows only the count when no overdue bill has a KES amount", () => {
    const bills = [bill({ status: "overdue", variable: true, amountKes: null })];
    expect(overdueSummary(bills)).toBe("1 overdue");
  });

  it("is null when nothing is overdue", () => {
    expect(overdueSummary([bill()])).toBeNull();
  });
});

describe("rowAmount", () => {
  it("formats KES bare, USD with its code and a missing amount as null", () => {
    expect(rowAmount(bill({ amountKes: "899900" }))).toBe("8,999.00");
    expect(
      rowAmount(bill({ currency: "usd", amountKes: null, amountUsdc: "120500000" })),
    ).toBe("USD 120.50");
    expect(rowAmount(bill({ amountKes: null, variable: true }))).toBeNull();
  });
});

describe("billWhen", () => {
  it("says how late an overdue bill is", () => {
    expect(billWhen(bill({ status: "overdue", dueOn: "2026-11-09" }), TODAY)).toEqual({
      text: "2 days late",
      negative: true,
    });
  });

  it("uses a human date for upcoming bills and marks recurring ones", () => {
    const upcoming = bill({
      dueOn: "2026-11-20",
      recurringItemId: "44444444-4444-4444-8444-444444444444",
    });
    expect(billWhen(upcoming, TODAY).text).toBe("Fri 20 Nov · recurring");
  });

  it("says when a settled bill was settled", () => {
    expect(billWhen(bill({ status: "paid", paidOn: "2026-11-05" }), TODAY).text).toBe(
      "Paid Thu 5 Nov",
    );
    expect(
      billWhen(
        bill({ status: "cancelled", cancelledAt: "2026-11-03T10:00:00.000Z" }),
        TODAY,
      ).text,
    ).toBe("Cancelled · Tue 3 Nov");
  });
});
