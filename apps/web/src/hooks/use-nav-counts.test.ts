import { describe, expect, it } from "vitest";

import type {
  BillsSummary,
  ClaimsSummary,
  ExpensesSummary,
  PayrollRun,
} from "@expendi-business/shared";

import { NAV_ITEMS } from "~/config/navigation";
import {
  billsNeedingAction,
  claimsWaiting,
  expensesMissingDocuments,
  payrollRunsWaiting,
} from "./use-nav-counts";

const totals = (count: number) => ({
  count,
  totalKes: "0",
  totalUsdc: "0",
});

const run = (status: PayrollRun["status"]) =>
  ({ status }) as Pick<PayrollRun, "status"> as PayrollRun;

describe("the sidebar's badges", () => {
  it("count overdue, due today and failed bills, not upcoming ones", () => {
    // #given
    const summary: BillsSummary = {
      views: { open: 12, paying: 1, history: 9 },
      toPay: { ...totals(12), withoutAmount: 1 },
      overdue: totals(2),
      dueToday: totals(2),
      payoutFailed: totals(1),
    };

    // #then
    expect(billsNeedingAction(summary)).toBe(5);
  });

  it("count reimbursements waiting for approval", () => {
    // #given
    const summary: ClaimsSummary = {
      waiting: { count: 6, totalKes: "4235000" },
      payoutFailed: { count: 1, totalKes: "185000" },
    };

    // #then
    expect(claimsWaiting(summary)).toBe(6);
  });

  it("count petty cash missing a receipt or an eTIMS invoice, each once", () => {
    // #given
    const kes = (count: number) => ({ count, totalKes: "0" });
    const summary = (
      withoutReceipt: number,
      withoutEtims: number,
    ): ExpensesSummary => ({
      ...kes(9),
      waitingForApproval: kes(0),
      withoutReceipt: kes(withoutReceipt),
      withoutEtims: kes(withoutEtims),
      kinds: { claim: 0, petty_cash: 9, company: 0 },
    });

    // #when
    const count = expensesMissingDocuments(summary(1, 3), summary(0, 1));

    // #then
    expect(count).toBe(2);
  });

  it("count payroll runs to approve or retry", () => {
    // #when
    const count = payrollRunsWaiting([
      run("draft"),
      run("partly_failed"),
      run("paying"),
      run("paid"),
    ]);

    // #then
    expect(count).toBe(2);
  });

  it("follow the founder's list: no Recurring, the wallet as Accounts, Invoices under Get paid", () => {
    // #when
    const titles = NAV_ITEMS.map((item) => item.title);
    const counted = NAV_ITEMS.flatMap((item) =>
      item.count ? [item.title] : [],
    );

    // #then
    expect({ titles, counted }).toEqual({
      titles: [
        "Overview",
        "Accounts",
        "Approvals",
        "Expenses",
        "Cards",
        "Bills",
        "Payroll",
        "Invoices",
        "Payees",
        "Team",
        "Settings",
        "Reports",
        "Activity",
      ],
      counted: ["Approvals", "Expenses", "Bills", "Payroll"],
    });
  });
});
