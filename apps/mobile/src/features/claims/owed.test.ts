import { describe, expect, it } from "vitest";

import {
  latestPayment,
  nairobiDay,
  owedTotalCents,
  reimbursementLine,
} from "./owed";

const claim = {
  status: "submitted" as const,
  merchant: "Uber",
  amountKes: "617000",
  rejectedReason: null,
  createdAt: "2026-11-09T08:00:00.000Z",
  paidAt: null,
};

describe("owedTotalCents", () => {
  it("adds waiting and on-the-way claims and ignores the rest", () => {
    // #given
    const claims = [
      { status: "submitted" as const, amountKes: "617000" },
      { status: "paying" as const, amountKes: "124000" },
      { status: "payout_failed" as const, amountKes: "1000" },
      { status: "rejected" as const, amountKes: "64000" },
      { status: "paid" as const, amountKes: "218000" },
    ];
    // #when
    const total = owedTotalCents(claims);
    // #then
    expect(total).toBe("742000");
  });

  it("is zero when nothing is owed", () => {
    // #given #when #then
    expect(owedTotalCents([])).toBe("0");
  });

  it("does not overflow past safe integers", () => {
    // #given
    const claims = [
      { status: "submitted" as const, amountKes: "9007199254740993" },
      { status: "submitted" as const, amountKes: "7" },
    ];
    // #when #then
    expect(owedTotalCents(claims)).toBe("9007199254741000");
  });
});

describe("nairobiDay", () => {
  it("moves a late UTC evening into the next Nairobi day", () => {
    // #given #when #then
    expect(nairobiDay("2026-11-05T22:30:00.000Z")).toBe("2026-11-06");
  });
});

describe("latestPayment", () => {
  const paidClaim = {
    status: "paid" as const,
    amountKes: "218000",
    paidAt: "2026-11-06T09:00:00.000Z",
  };

  it("picks the newest paid reimbursement", () => {
    // #given
    const older = { ...paidClaim, amountKes: "1", paidAt: "2026-10-01T09:00:00.000Z" };
    // #when
    const latest = latestPayment([older, paidClaim], []);
    // #then
    expect(latest).toEqual({ amountKes: "218000", day: "2026-11-06" });
  });

  it("prefers a salary paid on a later day", () => {
    // #given
    const salary = [{ status: "paid", amountKes: "9000000", paidOn: "2026-11-07" }];
    // #when
    const latest = latestPayment([paidClaim], salary);
    // #then
    expect(latest).toEqual({ amountKes: "9000000", day: "2026-11-07" });
  });

  it("keeps the reimbursement when the salary is older or on the same day", () => {
    // #given
    const salary = [{ status: "paid", amountKes: "9000000", paidOn: "2026-11-06" }];
    // #when
    const latest = latestPayment([paidClaim], salary);
    // #then
    expect(latest?.amountKes).toBe("218000");
  });

  it("ignores payments that are not paid yet", () => {
    // #given
    const salary = [{ status: "paying", amountKes: "9000000", paidOn: null }];
    // #when
    const latest = latestPayment([{ ...paidClaim, status: "paying" as const }], salary);
    // #then
    expect(latest).toBeNull();
  });
});

describe("reimbursementLine", () => {
  it("counts the days a claim has waited", () => {
    // #given #when
    const line = reimbursementLine(claim, "2026-11-11");
    // #then
    expect(line.meta).toBe("Waiting for approval · 2 days");
    expect(line.amount).toBe("6,170.00");
    expect(line.icon).toBe("waiting");
  });

  it("says just waiting on the day it was sent", () => {
    // #given #when
    const line = reimbursementLine(claim, "2026-11-09");
    // #then
    expect(line.meta).toBe("Waiting for approval");
  });

  it("shows a returned claim's reason in negative tone", () => {
    // #given
    const returned = {
      ...claim,
      status: "rejected" as const,
      rejectedReason: "add the trip receipt",
    };
    // #when
    const line = reimbursementLine(returned, "2026-11-11");
    // #then
    expect(line).toMatchObject({
      meta: "Returned · add the trip receipt",
      metaTone: "negative",
      icon: "returned",
    });
  });

  it("shows a paid claim with a human date and a muted amount", () => {
    // #given
    const paid = {
      ...claim,
      status: "paid" as const,
      paidAt: "2026-11-06T09:00:00.000Z",
    };
    // #when
    const line = reimbursementLine(paid, "2026-11-11");
    // #then
    expect(line).toMatchObject({
      meta: "Paid · Fri 6 Nov",
      metaTone: "positive",
      amountTone: "muted",
      icon: "paid",
    });
  });
});
