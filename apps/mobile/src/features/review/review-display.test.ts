import { describe, expect, it } from "vitest";

import type { Claim, ClaimDetail } from "@expendi-business/shared";

import {
  afterPaying,
  afterPayingParts,
  detailRows,
  etimsEvidence,
  queuePosition,
  queuePositionLabel,
  queueRowView,
  submittedLine,
  waitingLabel,
} from "./review-display";

const ID = "0b9f6c1e-3c2a-4d5e-8f70-1a2b3c4d5e6f";

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: ID,
    status: "submitted",
    merchant: "Kahawa Corner",
    amountKes: "124000",
    spentOn: "2026-11-04",
    description: "Coffee with Tausi",
    category: { id: ID, name: "Meals" },
    mpesaCode: null,
    etimsInvoiceNumber: null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: "none",
    rejectedReason: null,
    floatId: null,
    submittedBy: {
      membershipId: ID,
      name: "Brian Otieno",
      email: "brian@example.com",
      payoutPhoneConfirmed: true,
    },
    approvedAt: null,
    selfApproved: false,
    paidAt: null,
    canEdit: false,
    warnings: [],
    receiptCount: 1,
    createdAt: "2026-11-09T12:00:00.000Z",
    updatedAt: "2026-11-09T12:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<ClaimDetail> = {}): ClaimDetail {
  return { ...claim(), receipts: [], payout: null, ...overrides };
}

describe("afterPaying", () => {
  it("subtracts the reimbursement from what's available", () => {
    // #given 121,282.82 available and a 1,240.00 reimbursement
    // #when
    const result = afterPaying("12128282", "124000");
    // #then
    expect(result).toEqual({ kind: "available", kes: "120,042.82" });
  });

  it("reports the shortfall when paying would overdraw", () => {
    // #given 500.00 available and a 1,240.00 reimbursement
    // #when
    const result = afterPaying("50000", "124000");
    // #then
    expect(result).toEqual({ kind: "short", kes: "740.00" });
  });

  it("reports the shortfall when the company is already short", () => {
    // #given a negative available figure
    // #when
    const result = afterPaying("-1450000", "124000");
    // #then
    expect(result).toEqual({ kind: "short", kes: "15,740.00" });
  });

  it("is available at exactly zero left", () => {
    // #given
    // #when
    const result = afterPaying("124000", "124000");
    // #then
    expect(result).toEqual({ kind: "available", kes: "0.00" });
  });

  it("is null when the overview has no available figure", () => {
    // #given
    // #when
    const result = afterPaying(null, "124000");
    // #then
    expect(result).toBeNull();
  });
});

describe("afterPayingParts", () => {
  it("says what is available and to when", () => {
    // #given
    // #when
    const parts = afterPayingParts(
      { kind: "available", kes: "120,042.82" },
      "2026-12-10",
    );
    // #then
    expect(parts).toEqual({
      before: "After paying, ",
      amount: "KES 120,042.82",
      after: " is available to 10 Dec.",
    });
  });

  it("says plainly when paying leaves the company short", () => {
    // #given
    // #when
    const parts = afterPayingParts({ kind: "short", kes: "740.00" }, "2026-12-10");
    // #then
    expect(`${parts.before}${parts.amount}${parts.after}`).toBe(
      "Paying this leaves the company KES 740.00 short for what's due to 10 Dec.",
    );
  });
});

describe("queuePosition", () => {
  it("counts from one", () => {
    // #given
    const ids = ["a", "b", "c"];
    // #when
    const position = queuePosition(ids, "b");
    // #then
    expect(position).toEqual({ position: 2, total: 3 });
    expect(position && queuePositionLabel(position)).toBe("2 of 3");
  });

  it("is null when the reimbursement isn't in the queue", () => {
    // #given
    // #when
    const position = queuePosition(["a"], "z");
    // #then
    expect(position).toBeNull();
  });
});

describe("submittedLine and waitingLabel", () => {
  it("says how many days ago it was submitted", () => {
    // #given submitted on 9 Nov, today 11 Nov
    // #when
    const line = submittedLine("2026-11-09T12:00:00.000Z", "2026-11-11");
    // #then
    expect(line).toBe("Submitted Mon 9 Nov · 2 days ago");
  });

  it("says today for one submitted today", () => {
    // #given
    // #when
    const line = submittedLine("2026-11-11T12:00:00.000Z", "2026-11-11");
    // #then
    expect(line).toBe("Submitted Wed 11 Nov · today");
    expect(waitingLabel("2026-11-11T12:00:00.000Z", "2026-11-11")).toBe(
      "Submitted today",
    );
  });

  it("uses the singular for one day", () => {
    // #given
    // #when
    const label = waitingLabel("2026-11-10T12:00:00.000Z", "2026-11-11");
    // #then
    expect(label).toBe("Waiting 1 day");
  });
});

describe("queueRowView", () => {
  it("shows person, merchant and waiting time with no flags", () => {
    // #given
    // #when
    const row = queueRowView(claim(), "2026-11-11", false);
    // #then
    expect(row).toMatchObject({
      title: "Brian Otieno",
      meta: "Kahawa Corner · Waiting 2 days",
      metaTone: "default",
      amount: "1,240.00",
      flags: [],
    });
  });

  it("flags a possible duplicate in the warning tone", () => {
    // #given
    const warned = claim({
      warnings: [
        { code: "near_duplicate", expenseId: ID, spentOn: "2026-11-04", amountKes: "124000" },
      ],
    });
    // #when
    const row = queueRowView(warned, "2026-11-11", false);
    // #then
    expect(row.metaTone).toBe("negative");
    expect(row.meta).toBe("Possible duplicate\nKahawa Corner · Waiting 2 days");
  });

  it("flags a missing payout number, but not on a failed payment", () => {
    // #given
    const noPhone = claim({
      submittedBy: { ...claim().submittedBy, payoutPhoneConfirmed: false },
    });
    // #when
    const waiting = queueRowView(noPhone, "2026-11-11", false);
    const failed = queueRowView(noPhone, "2026-11-11", true);
    // #then
    expect(waiting.flags).toEqual(["No payout number yet"]);
    expect(failed.flags).toEqual(["Payment failed"]);
  });

  it("falls back to the email when the person has no name", () => {
    // #given
    const unnamed = claim({
      submittedBy: { ...claim().submittedBy, name: null },
    });
    // #when
    const row = queueRowView(unnamed, "2026-11-11", false);
    // #then
    expect(row.title).toBe("brian@example.com");
  });
});

describe("detailRows", () => {
  it("shows the payout and the submitter's note to an admin", () => {
    // #given
    // #when
    const rows = detailRows(detail(), true);
    // #then
    expect(rows).toEqual([
      { label: "Category", value: "Meals" },
      { label: "Pay to", value: "M-Pesa, number confirmed" },
      { label: "Note from Brian", value: "Coffee with Tausi", stacked: true },
      { label: "eTIMS", value: "No invoice" },
    ]);
  });

  it("leaves the payout out for the employee", () => {
    // #given
    // #when
    const rows = detailRows(detail(), false);
    // #then
    expect(rows.map((row) => row.label)).toEqual([
      "Category",
      "What it was for",
      "eTIMS",
    ]);
  });

  it("moves an attached eTIMS invoice to the evidence", () => {
    // #given
    const withInvoice = detail({
      etimsStatus: "attached",
      etimsInvoiceNumber: "0100123",
      etimsSupplierPin: "P051234567Z",
    });
    // #when
    const rows = detailRows(withInvoice, true);
    const evidence = etimsEvidence(withInvoice);
    // #then
    expect(rows.some((row) => row.label === "eTIMS")).toBe(false);
    expect(evidence).toEqual({
      title: "eTIMS invoice",
      meta: "0100123 · Supplier PIN P051234567Z",
    });
  });

  it("has no eTIMS evidence without an invoice", () => {
    // #given
    // #when
    const evidence = etimsEvidence(detail());
    // #then
    expect(evidence).toBeNull();
  });
});
