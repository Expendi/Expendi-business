import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Expense } from "@expendi-business/shared";

import {
  pageText,
  RECEIPT_SAMPLES,
  showsReceipt,
} from "~/components/data/payment-receipts.samples";
import { ExpenseDetails } from "./expense-sheet";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A reimbursement paid through Expendi, for a purchase paid with M-Pesa. */
const PAID_CLAIM: Expense = {
  id: id(1),
  kind: "claim",
  listKind: "claim",
  status: "paid",
  source: "app",
  overviewHeading: "transactions",
  merchant: "Naivas Supermarket",
  amountKes: "30000",
  spentOn: "2026-10-15",
  description: null,
  category: { id: id(2), name: "Office supplies" },
  member: { membershipId: id(3), name: "Jane Wanjiku", email: "j@e.com" },
  mpesaCode: "SK41H7QZ2P",
  etimsStatus: "none",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  warnings: [],
  receiptCount: 1,
  noReceipt: false,
  noReceiptReason: null,
  rejectedReason: null,
  selfApproved: false,
  approvedAt: "2026-10-31T08:00:00.000Z",
  paidAt: "2026-10-31T09:00:00.000Z",
  paymentReceipts: [],
  floatId: null,
  overspendClaimId: null,
  bill: null,
  paidFromAccount: null,
  createdAt: "2026-10-15T09:00:00.000Z",
};

function details(expense: Expense): string {
  return pageText(
    renderToStaticMarkup(<ExpenseDetails expense={expense} receipts={null} />),
  );
}

describe("a reimbursement's receipt in the expense sheet", () => {
  it.each(RECEIPT_SAMPLES)(
    "shows $name right after Paid, apart from the purchase's M-Pesa code",
    (receipt) => {
      // #when
      const page = details({
        ...PAID_CLAIM,
        paymentReceipts: [...receipt.receipts],
      });

      // #then
      expect({
        receipt: page.includes(`Paid 31 Oct 2026 ${receipt.reads}`),
        purchaseCode: page.includes("M-Pesa code SK41H7QZ2P Paid 31 Oct 2026"),
      }).toEqual({ receipt: true, purchaseCode: true });
    },
  );

  it("shows no receipt row until the reimbursement is paid", () => {
    // #when
    const page = details({ ...PAID_CLAIM, paidAt: null, status: "paying" });

    // #then
    expect(showsReceipt(page)).toBe(false);
  });
});
