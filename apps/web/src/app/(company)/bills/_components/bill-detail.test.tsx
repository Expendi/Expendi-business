import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BillDetail } from "@expendi-business/shared";

import type { ReceiptDownload } from "~/features/bills/receipt-download";
import { BILL_DETAILS } from "~/app/dev/preview/_harness/fixtures/bills";
import {
  pageText,
  RECEIPT_SAMPLES,
  showsReceipt,
} from "~/components/data/payment-receipts.samples";
import { BillDetailBody } from "./bill-detail";

function sample(find: (bill: BillDetail) => boolean): BillDetail {
  const bill = BILL_DETAILS.find(find);
  if (!bill) throw new Error("No such sample bill");
  return bill;
}

const PAID = sample(
  (bill) => bill.status === "paid" && bill.paymentReceipts.length > 0,
);

function details(bill: BillDetail): string {
  return pageText(
    renderToStaticMarkup(
      <BillDetailBody bill={bill} error={null} onSeeRecurring={vi.fn()} />,
    ),
  );
}

describe("a paid bill's receipt", () => {
  it.each(RECEIPT_SAMPLES)("shows $name right after Paid on", (receipt) => {
    // #when
    const page = details({ ...PAID, paymentReceipts: [...receipt.receipts] });

    // #then
    expect(page).toContain(`Paid on 4 Nov 2026 ${receipt.reads}`);
  });

  it("shows no receipt row until a cash-out is paid", () => {
    // #when
    const page = details({ ...PAID, paymentReceipts: [] });

    // #then
    expect({
      paidOn: page.includes("Paid on 4 Nov 2026"),
      receipt: showsReceipt(page),
    }).toEqual({ paidOn: true, receipt: false });
  });
});

describe("a bill's files", () => {
  it("says no invoice is attached when it has none", () => {
    // #when
    const page = details({ ...PAID, files: [], fileCount: 0 });

    // #then
    expect({
      invoice: page.includes("No invoice attached."),
      receipt: page.includes("No receipt attached."),
    }).toEqual({ invoice: true, receipt: false });
  });
});

describe("a bill's receipt download", () => {
  const idle: ReceiptDownload = {
    billId: null,
    pending: false,
    error: null,
    start: vi.fn(),
  };

  function withDownload(bill: BillDetail, download = idle): string {
    return pageText(
      renderToStaticMarkup(
        <BillDetailBody
          bill={bill}
          error={null}
          receiptDownload={download}
          onSeeRecurring={vi.fn()}
        />,
      ),
    );
  }

  const paidThroughExpendi: BillDetail = {
    ...PAID,
    payrollRunId: null,
    payout: { id: "payout-1", status: "paid", failureReason: null },
  };

  it("offers the receipt of a bill paid through Expendi", () => {
    // #when
    const page = withDownload(paidThroughExpendi);

    // #then
    expect(page).toContain("Download receipt");
  });

  it("offers none for a bill paid outside Expendi or still being paid", () => {
    // #given
    const outside: BillDetail = { ...paidThroughExpendi, payout: null };
    const paying: BillDetail = {
      ...paidThroughExpendi,
      payout: { id: "payout-1", status: "paying", failureReason: null },
    };

    // #when
    const pages = [withDownload(outside), withDownload(paying)];

    // #then
    expect(pages.map((page) => page.includes("Download receipt"))).toEqual([
      false,
      false,
    ]);
  });

  it("offers none for a salary", () => {
    // #given
    const salary: BillDetail = {
      ...paidThroughExpendi,
      payrollRunId: "00000000-0000-4000-8000-000000000009",
    };

    // #when
    const page = withDownload(salary);

    // #then
    expect(page).not.toContain("Download receipt");
  });

  it("shows a failed download inline", () => {
    // #given
    const failed: ReceiptDownload = {
      ...idle,
      billId: paidThroughExpendi.id,
      error: "Your session ended. Sign in again.",
    };

    // #when
    const page = withDownload(paidThroughExpendi, failed);

    // #then
    expect(page).toContain("Your session ended. Sign in again.");
  });
});
