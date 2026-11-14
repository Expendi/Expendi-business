import { describe, expect, it } from "vitest";

import type {
  MySalaryPayment,
  PayrollRun,
  Salary,
} from "@expendi-business/shared";

import {
  monthName,
  nextPayDay,
  nextRun,
  pastRuns,
  paymentRowData,
  payoutLabel,
  runRowData,
} from "./payroll-overview";

function run(overrides: Partial<PayrollRun>): PayrollRun {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    payDate: "2026-11-28",
    status: "draft",
    totalKes: "21432100",
    salariesKes: "21000000",
    capKes: "22000000",
    people: 7,
    leftOut: 0,
    adjusted: 0,
    oneOffs: 0,
    progress: { paid: 0, paying: 0, failed: 0 },
    createdAt: "2026-11-23T08:00:00.000Z",
    approvedAt: null,
    ...overrides,
  };
}

function salary(overrides: Partial<Salary>): Salary {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    state: "active",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Amina",
      kind: "employee",
      method: "mpesa_phone",
      archived: false,
      payoutPhoneConfirmed: true,
      accountEnding: null,
    },
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Salaries" },
    amountKes: "5000000",
    payDay: 28,
    startsOn: "2026-01-01",
    endsOn: null,
    nextPayDate: "2026-11-28",
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("nextRun", () => {
  it("picks the earliest run that isn't paid", () => {
    // #given
    const runs = [
      run({ id: "a", payDate: "2026-12-28" }),
      run({ id: "b", payDate: "2026-11-28" }),
      run({ id: "c", payDate: "2026-10-28", status: "paid" }),
    ];

    // #when
    const next = nextRun(runs);

    // #then
    expect(next?.id).toBe("b");
  });

  it("is null when every run is paid or there are none", () => {
    // #given
    const paid = [run({ status: "paid" })];

    // #then
    expect(nextRun(paid)).toBeNull();
    expect(nextRun([])).toBeNull();
  });

  it("counts a run with failed payments as still open", () => {
    // #given
    const runs = [run({ id: "x", status: "partly_failed" })];

    // #then
    expect(nextRun(runs)?.id).toBe("x");
  });
});

describe("pastRuns", () => {
  it("leaves out the next run and lists the rest latest first", () => {
    // #given
    const runs = [
      run({ id: "sep", payDate: "2026-09-28", status: "paid" }),
      run({ id: "nov", payDate: "2026-11-28" }),
      run({ id: "oct", payDate: "2026-10-28", status: "paid" }),
    ];

    // #when
    const past = pastRuns(runs);

    // #then
    expect(past.map((entry) => entry.id)).toEqual(["oct", "sep"]);
  });
});

describe("nextPayDay", () => {
  it("is the soonest pay day among active salaries", () => {
    // #given
    const salaries = [
      salary({ nextPayDate: "2026-12-05" }),
      salary({ nextPayDate: "2026-11-28" }),
      salary({ state: "paused", nextPayDate: "2026-11-01" }),
    ];

    // #then
    expect(nextPayDay(salaries)).toBe("2026-11-28");
    expect(nextPayDay([])).toBeNull();
  });
});

describe("labels", () => {
  it("names the month and the payout method", () => {
    expect(monthName("2026-10-28")).toBe("October");
    expect(payoutLabel("mpesa_phone")).toBe("M-PESA");
    expect(payoutLabel(null)).toBe("No payment details yet");
  });
});

describe("runRowData", () => {
  it("shows a paid run positively with a human date", () => {
    // #given
    const paid = run({ payDate: "2026-10-28", status: "paid" });

    // #when
    const row = runRowData(paid, "2026-11-11");

    // #then
    expect(row).toMatchObject({
      title: "October",
      meta: "Paid Wed 28 Oct",
      tone: "positive",
    });
  });

  it("flags a run with failed payments", () => {
    // #given
    const failed = run({ status: "partly_failed" });

    // #then
    expect(runRowData(failed, "2026-11-11").metaTone).toBe("negative");
  });
});

describe("paymentRowData", () => {
  const payment = (overrides: Partial<MySalaryPayment>): MySalaryPayment => ({
    id: "00000000-0000-4000-8000-0000000000b1",
    paymentReceipts: [],
    kind: "salary",
    payDate: "2026-11-06",
    amountKes: "218000",
    status: "paid",
    paidOn: "2026-11-06",
    ...overrides,
  });

  it("describes a paid salary by its paid date", () => {
    // #when
    const row = paymentRowData(payment({}), "2026-11-11");

    // #then
    expect(row).toEqual({
      title: "Salary",
      meta: "Paid · Fri 6 Nov",
      metaTone: "positive",
      amount: "2,180.00",
      paid: true,
    });
  });

  it("describes a payment on its way by its pay day", () => {
    // #when
    const row = paymentRowData(
      payment({ kind: "one_off", status: "paying", paidOn: null }),
      "2026-11-11",
    );

    // #then
    expect(row.title).toBe("Extra payment");
    expect(row.meta).toBe("Being paid · pay day Fri 6 Nov");
    expect(row.paid).toBe(false);
  });
});
