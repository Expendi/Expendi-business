import { describe, expect, it } from "vitest";

import type { CashObligation } from "@expendi-business/shared";

import {
  OPEN_FLOATS,
  OVERVIEW,
  SPENDING_TREND,
} from "~/app/dev/preview/_harness/fixtures/overview";
import {
  biggestRise,
  cardEstimateUsdc,
  cashLedger,
  categoryBars,
  comingUp,
  expenseMeta,
  floatRows,
  greeting,
  inboxGroups,
  inboxTitle,
  largestPayments,
  nairobiHour,
  obligationHref,
  obligationWhat,
  paymentMeta,
  spendingSeries,
} from "./overview-display";

const obligation = (fields: Partial<CashObligation>): CashObligation => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "bill",
  name: "KRA",
  notes: null,
  schedule: null,
  people: null,
  dueOn: "2026-11-09",
  amountKes: "21240000",
  status: "unpaid",
  payVia: "expendi",
  needsAmount: false,
  heading: "transactions",
  ...fields,
});

describe("greeting", () => {
  it("greets by the Nairobi hour and first name", () => {
    expect(greeting(8, "Wanjiru Kamau")).toBe("Good morning, Wanjiru");
    expect(greeting(13, "Wanjiru Kamau")).toBe("Good afternoon, Wanjiru");
    expect(greeting(19, null)).toBe("Good evening");
  });

  it("reads the hour in Nairobi, three hours ahead of UTC", () => {
    expect(nairobiHour(new Date("2026-11-06T06:30:00Z"))).toBe(9);
    expect(nairobiHour(new Date("2026-11-06T22:30:00Z"))).toBe(1);
  });
});

describe("due payments", () => {
  it("links bills, payroll runs and forecasts to where they're paid", () => {
    expect(obligationHref(obligation({ id: "b1" }))).toBe("/bills?billId=b1");
    expect(obligationHref(obligation({ id: "r1", kind: "payroll" }))).toBe(
      "/payroll?runId=r1",
    );
    expect(
      obligationHref(
        obligation({ id: "s1", kind: "forecast", heading: "salaries" }),
      ),
    ).toBe("/payroll");
    expect(obligationHref(obligation({ id: "i1", kind: "forecast" }))).toBe(
      "/bills?recurring=i1",
    );
  });

  it("says what each payment is for", () => {
    expect(obligationWhat(obligation({ notes: "PAYE for October" }))).toBe(
      "PAYE for October",
    );
    expect(
      obligationWhat(obligation({ notes: "Water bill", schedule: "monthly" })),
    ).toBe("Water bill, monthly");
    expect(obligationWhat(obligation({ kind: "payroll", people: 14 }))).toBe(
      "14 people",
    );
    expect(obligationWhat(obligation({ kind: "payroll", people: 1 }))).toBe(
      "1 person",
    );
    expect(obligationWhat(obligation({ kind: "forecast" }))).toBe(
      "Not billed yet",
    );
    expect(obligationWhat(obligation({}))).toBe("Due 9 Nov");
  });

  it("adds the due date to a late payment's line", () => {
    const rent = obligation({
      notes: "Office rent for November",
      dueOn: "2026-11-01",
    });
    expect(paymentMeta(rent, 5)).toBe("Office rent for November, due 1 Nov");
    expect(paymentMeta(rent, 0)).toBe("Office rent for November");
    expect(paymentMeta(obligation({ dueOn: "2026-11-01" }), 5)).toBe(
      "Due 1 Nov",
    );
  });

  it("lists what's coming up after today in date order", () => {
    const rows = comingUp(OVERVIEW.cash);
    expect(rows).toHaveLength(11);
    expect(rows[0]?.name).toBe("KRA");
    expect(rows.every((row) => row.dueOn > OVERVIEW.cash.today)).toBe(true);
  });
});

describe("the inbox", () => {
  it("groups payments, reimbursements and missing documents", () => {
    const groups = inboxGroups(OVERVIEW);
    expect(groups.map((group) => [group.title, group.items.length])).toEqual([
      ["Payments", 2],
      ["Approvals", 2],
      ["Missing documents", 2],
    ]);
    const [rent] = groups[0]?.items ?? [];
    expect(rent?.kind === "payment" && rent.overdueDays).toBe(5);
  });

  it("leaves out empty groups", () => {
    const groups = inboxGroups({
      ...OVERVIEW,
      outstanding: { ...OVERVIEW.outstanding, overdue: [], dueToday: [] },
    });
    expect(groups.map((group) => group.id)).toEqual(["approvals", "documents"]);
  });

  it("titles the count for admins and accountants", () => {
    expect(inboxTitle(6, true)).toBe("6 things need you");
    expect(inboxTitle(1, true)).toBe("1 thing needs you");
    expect(inboxTitle(6, false)).toBe("6 things are waiting");
    expect(inboxTitle(0, true)).toBe("You're all caught up");
  });

  it("describes a reimbursement and a float purchase", () => {
    const [lunch] = OVERVIEW.outstanding.claims;
    const [fuel] = OVERVIEW.outstanding.noReceipt;
    if (!lunch || !fuel) throw new Error("fixture changed");
    expect(expenseMeta(lunch, "claim")).toBe(
      "Client lunch at Java House on 4 Nov · Meals & entertainment",
    );
    expect(expenseMeta(fuel, "receipt")).toBe(
      "Fuel on 3 Nov · Kevin Mwangi's float",
    );
    expect(expenseMeta({ ...fuel, description: null }, "receipt")).toBe(
      "Fuel & transport on 3 Nov · Kevin Mwangi's float",
    );
  });
});

describe("the wallet against the next 30 days", () => {
  it("works out what's leaving and what's left over from the API's figures", () => {
    expect(cashLedger(OVERVIEW.cash)).toEqual({
      inProgressKes: "22476000",
      leftOverKes: "3352320",
    });
  });

  it("has nothing to show without the KES rate", () => {
    expect(
      cashLedger({ ...OVERVIEW.cash, balanceKes: null, availableKes: null }),
    ).toEqual({ inProgressKes: null, leftOverKes: null });
  });
});

describe("floats", () => {
  it("puts the lowest first and flags under a quarter left", () => {
    const rows = floatRows(OPEN_FLOATS.floats);
    expect(rows.map((row) => row.float.holder.name)).toEqual([
      "Grace Achieng",
      "Kevin Mwangi",
      "Site team, Machakos",
    ]);
    expect(rows.map((row) => row.low)).toEqual([true, false, false]);
  });
});

describe("spending charts", () => {
  it("shows the months after the one the API adds for comparison", () => {
    const series = spendingSeries(SPENDING_TREND);
    expect(series.months).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(series.total.at(-1)).toBe(1_920_000);
    expect(series.outsidePayroll.at(-1)).toBe(680_000);
  });

  it("ranks categories outside payroll and folds the tail into Other", () => {
    const bars = categoryBars(SPENDING_TREND);
    expect(bars.map((bar) => [bar.name, bar.current, bar.previous])).toEqual([
      ["Suppliers", 286_000, 262_000],
      ["Fuel & transport", 162_000, 124_000],
      ["Rent & utilities", 98_000, 98_000],
      ["Office & supplies", 64_000, 58_000],
      ["Airtime & internet", 38_000, 36_000],
      ["Other", 32_000, 20_000],
    ]);
  });

  it("finds the category that drove the rise", () => {
    expect(biggestRise(categoryBars(SPENDING_TREND))).toEqual({
      name: "Fuel & transport",
      percent: 31,
      share: 46,
    });
    expect(
      biggestRise([{ id: "a", name: "Rent", current: 90, previous: 100 }]),
    ).toBeNull();
  });

  it("leaves salaries out of the largest payments", () => {
    const names = largestPayments(SPENDING_TREND).map((row) => row.name);
    expect(names).toEqual([
      "Bidco Kenya",
      "Twiga Foods",
      "Unga Limited",
      "Kilimani Properties",
      "TotalEnergies Kenya",
    ]);
  });
});

describe("cardEstimateUsdc", () => {
  it("turns a company-held card's US cents into USDC units, or null without an estimate", () => {
    expect([
      cardEstimateUsdc({ amountUsdCents: "2000" }),
      cardEstimateUsdc({ amountUsdCents: null }),
      cardEstimateUsdc({}),
    ]).toEqual(["20000000", null, null]);
  });
});
