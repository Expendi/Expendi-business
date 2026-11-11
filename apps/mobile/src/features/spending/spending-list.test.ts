import { describe, expect, it } from "vitest";

import type { CompanySpending } from "@expendi-business/shared";

import { spendingRowMeta } from "./spending-list";

function item(overrides: Partial<CompanySpending> = {}): CompanySpending {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    status: "recorded",
    overviewHeading: "subscriptions",
    merchant: "Google Workspace",
    amountKes: "602000",
    spentOn: "2026-11-05",
    description: null,
    category: { id: "33333333-3333-4333-8333-333333333333", name: "Software" },
    paidFromAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "KCB current account",
      kind: "bank",
      archived: false,
    },
    bill: null,
    mpesaCode: null,
    etimsInvoiceNumber: null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: "none",
    noReceipt: false,
    noReceiptReason: null,
    warnings: [],
    receiptCount: 1,
    recordedBy: {
      membershipId: "77777777-7777-4777-8777-777777777777",
      name: "Wanjiku",
      email: "wanjiku@example.com",
    },
    createdAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
    ...overrides,
  };
}

describe("spendingRowMeta", () => {
  it("reads heading, human date and account when nothing is wrong", () => {
    // #when
    const meta = spendingRowMeta(item(), "2026-11-11");

    // #then
    expect(meta).toEqual({
      text: "Subscriptions · Thu 5 Nov · KCB current account",
      needsAttention: false,
    });
  });

  it("flags a missing receipt and notes a bill origin", () => {
    // #when
    const meta = spendingRowMeta(
      item({ noReceipt: true, paidFromAccount: null }),
      "2026-11-11",
    );

    // #then
    expect(meta.text).toBe(
      "Subscriptions · Thu 5 Nov · Account not specified · no receipt",
    );
    expect(meta.needsAttention).toBe(true);
  });

  it("lists each kind of warning once", () => {
    // #when
    const meta = spendingRowMeta(
      item({
        warnings: [
          { code: "near_duplicate", expenseId: "e1", amountKes: "1", spentOn: "2026-11-04" },
          { code: "near_duplicate", expenseId: "e2", amountKes: "1", spentOn: "2026-11-03" },
        ],
      }),
      "2026-11-11",
    );

    // #then
    expect(meta.text.match(/possible duplicate/g)).toHaveLength(1);
    expect(meta.needsAttention).toBe(true);
  });
});
