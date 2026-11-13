import { describe, expect, it } from "vitest";

import type {
  Bill,
  BillPaymentPreview,
  BillPaymentResult,
} from "@expendi-business/shared";

import { ApiError } from "../../lib/api";
import {
  billPreviewRows,
  describeBillPaymentResult,
  holdFrom,
  holdWarning,
  isPayable,
  joinBillIds,
  splitBillIds,
  toggleSelection,
} from "./bill-payment";

const PAYEE_ID = "11111111-1111-4111-8111-111111111111";

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "due",
    payee: {
      id: PAYEE_ID,
      name: "Kenya Power",
      kind: "supplier",
      method: "mpesa_paybill",
      archived: false,
    },
    overviewHeading: "transactions",
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Utilities" },
    variable: false,
    currency: "kes",
    amountKes: "250000",
    amountUsdc: null,
    reference: null,
    notes: null,
    dueOn: "2026-11-10",
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
    paymentReceipts: [],
    fileCount: 0,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

const preview = (
  overrides: Partial<BillPaymentPreview> = {},
): BillPaymentPreview => ({
  billId: "00000000-0000-4000-8000-000000000001",
  payoutId: "00000000-0000-4000-8000-000000000002",
  payeeName: "Kenya Power",
  paidTo: { method: "mpesa_paybill", label: "Paybill 888880, account A-17" },
  currency: "kes",
  billedKes: "250050",
  receivesKes: "250100",
  receivesUsdc: null,
  kesEquivalent: "250100",
  rate: "128.68",
  usdc: "19435000",
  feeAllowanceUsdc: "347175",
  maxDebitUsdc: "19782175",
  ...overrides,
});

describe("isPayable", () => {
  it.each([
    ["an unpaid KES bill", {}, true],
    ["a failed payment, to retry", { status: "payout_failed" as const }, true],
    ["a bill already being paid", { status: "paying" as const }, false],
    ["a variable bill with no amount", { amountKes: null }, false],
    [
      "a salary, paid with its run",
      { payrollRunId: "33333333-3333-4333-8333-333333333333" },
      false,
    ],
  ])("%s → %s", (_, overrides, expected) => {
    // #then
    expect(isPayable(bill(overrides))).toBe(expected);
  });

  it("refuses a payee paid outside Expendi, and a KES bill to a payee now paid in USDC", () => {
    // #given
    const outside = bill({ payee: { ...bill().payee, method: "outside" } });
    const mismatched = bill({ payee: { ...bill().payee, method: "usdc" } });

    // #then
    expect([isPayable(outside), isPayable(mismatched)]).toEqual([false, false]);
  });

  it("pays a USD bill to a payee paid in USDC", () => {
    // #given
    const usd = bill({
      payee: { ...bill().payee, method: "usdc" },
      currency: "usd",
      amountKes: null,
      amountUsdc: "60500000",
    });

    // #then
    expect(isPayable(usd)).toBe(true);
  });

  it("leaves a bill a company-held card pays out of Pay and Pay all, declined or not", () => {
    // #given
    const card = {
      id: "44444444-4444-4444-8444-444444444444",
      nickname: "Software",
      lastFour: "1234",
    };
    const automatic = bill({
      id: "00000000-0000-4000-8000-00000000000a",
      card,
    });
    const declined = bill({
      id: "00000000-0000-4000-8000-00000000000b",
      card,
      status: "overdue",
      cardDeclinedAt: "2026-11-12T08:00:00.000Z",
      cardDeclineReason: "The Card balance is too low.",
    });
    const ordinary = bill({ id: "00000000-0000-4000-8000-00000000000c" });
    const open = [automatic, declined, ordinary];

    // #then
    expect({
      automatic: isPayable(automatic),
      declined: isPayable(declined),
      selectable: open.filter(isPayable).map(({ id }) => id),
      payAllOffered: [automatic, declined].some(isPayable),
    }).toEqual({
      automatic: false,
      declined: false,
      selectable: [ordinary.id],
      payAllOffered: false,
    });
  });
});

describe("Pay all's selection", () => {
  it("adds, removes, and stops at 20 bills", () => {
    // #given
    const twenty = Array.from({ length: 20 }, (_, index) => `bill-${index}`);

    // #then
    expect({
      added: toggleSelection(["a"], "b"),
      removed: toggleSelection(["a", "b"], "a"),
      full: toggleSelection(twenty, "one-more").length,
      roundTrip: splitBillIds(joinBillIds(["a", "b"])),
      none: splitBillIds(undefined),
    }).toEqual({
      added: ["a", "b"],
      removed: ["b"],
      full: 20,
      roundTrip: ["a", "b"],
      none: [],
    });
  });
});

describe("billPreviewRows", () => {
  it("shows the KES received, rounded up, where it goes and the most it costs", () => {
    // #when
    const rows = billPreviewRows(preview());

    // #then
    expect(rows).toEqual([
      { label: "They receive", value: "KES 2,501.00" },
      {
        label: "Billed",
        value: "KES 2,500.50, rounded up to a whole shilling",
      },
      { label: "Paid to", value: "Paybill 888880, account A-17" },
      { label: "USDC", value: "19.435 USDC" },
      { label: "Cash-out fee, at most", value: "0.347175 USDC" },
      { label: "Total, at most", value: "19.782175 USDC" },
    ]);
  });

  it("shows a USD bill's exact USDC and what it counts towards the cap", () => {
    // #when
    const rows = billPreviewRows(
      preview({
        currency: "usd",
        paidTo: { method: "usdc", label: "0x1234…abcd" },
        billedKes: null,
        receivesKes: null,
        receivesUsdc: "60500000",
        kesEquivalent: "778514",
        usdc: "60500000",
        feeAllowanceUsdc: "0",
        maxDebitUsdc: "60500000",
      }),
    );

    // #then
    expect(rows.slice(0, 3)).toEqual([
      { label: "They receive", value: "60.50 USDC, exactly" },
      { label: "Paid to", value: "0x1234…abcd" },
      { label: "Counts towards today’s cap as", value: "KES 7,785.14" },
    ]);
  });
});

describe("the 24-hour hold (spec §6.19)", () => {
  const details = {
    reason: "payee_details_changed",
    payees: [
      {
        payeeId: PAYEE_ID,
        name: "Acme Supplies",
        detailsChangedAt: "2026-11-02T07:00:00.000Z",
      },
    ],
  };

  it("is read from the API's 409", () => {
    // #given
    const error = new ApiError(409, "Conflict", "changed", details);

    // #then
    expect({
      hold: holdFrom(error)?.payees.map((payee) => payee.name),
      otherConflict: holdFrom(new ApiError(409, "Conflict", "nope", {})),
      otherError: holdFrom(new Error("boom")),
    }).toEqual({
      hold: ["Acme Supplies"],
      otherConflict: null,
      otherError: null,
    });
  });

  it("warns about swapped payment details, naming the payee", () => {
    // #when
    const hold = holdFrom(new ApiError(409, "Conflict", "changed", details));
    const warning = hold ? holdWarning(hold) : null;

    // #then
    expect(warning?.body).toContain(
      "Acme Supplies had their payment details changed in the last 24 hours. Swapped payment details are a common route for payment fraud.",
    );
  });
});

describe("describeBillPaymentResult", () => {
  const row = (
    billId: string,
    status: BillPaymentResult["bills"][number]["status"],
    payoutStatus: BillPaymentResult["bills"][number]["payout"]["status"],
    failureReason: string | null = null,
  ) => ({
    billId,
    status,
    payout: { id: `${billId}-payout`, status: payoutStatus, failureReason },
  });

  it("names the failed bill to retry, the others unaffected", () => {
    // #when
    const summary = describeBillPaymentResult({
      bills: [
        row("a", "paying", "paying"),
        row("b", "payout_failed", "failed", "Paycrest refused the order"),
        row("c", "paying", "paying"),
      ],
    });

    // #then
    expect(summary).toMatchObject({
      outcome: "failed",
      failedBillIds: ["b"],
      failureReason: "Paycrest refused the order",
    });
  });

  it("puts a payment under review first", () => {
    // #when
    const summary = describeBillPaymentResult({
      bills: [
        row("a", "payout_failed", "failed"),
        row("b", "paying", "needs_review"),
      ],
    });

    // #then
    expect(summary.outcome).toBe("review");
  });
});
