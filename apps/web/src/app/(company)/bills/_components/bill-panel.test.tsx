import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BillDetail } from "@expendi-business/shared";

import { billKeys } from "~/features/payment-keys";
import { BillPanel } from "./bill-panel";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const bill: BillDetail = {
  id: id(1),
  status: "due",
  payee: {
    id: id(50),
    name: "KRA",
    kind: "statutory",
    method: "mpesa_paybill",
    archived: false,
  },
  overviewHeading: "transactions",
  category: { id: id(60), name: "Taxes" },
  variable: true,
  currency: "kes",
  amountKes: null,
  amountUsdc: null,
  reference: null,
  notes: "PAYE for October",
  dueOn: "2026-11-09",
  recurringItemId: id(70),
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
  fileCount: 1,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  files: [
    {
      id: id(5),
      role: "invoice",
      kind: "pdf",
      contentType: "application/pdf",
      url: "https://r2.example.com/org/receipts/paye.pdf?X-Amz-Signature=abc",
      expiresAt: "2026-11-02T09:15:00.000Z",
    },
  ],
};

function render(detail: BillDetail, canAct: boolean): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(billKeys.detail(ORG, detail.id), detail);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BillPanel
        organizationId={ORG}
        billId={detail.id}
        canAct={canAct}
        rate={null}
        paymentBusy={false}
        onPay={() => undefined}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

function buttonsOf(html: string): (string | undefined)[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)</g)].map(([, label]) => label);
}

describe("a bill's panel", () => {
  it("asks an admin for a variable bill's amount before it can be paid, with its invoice PDF beside it", () => {
    // #when
    const html = render(bill, true);

    // #then
    expect({
      pdf: html.includes('src="https://r2.example.com/org/receipts/paye.pdf'),
      reason: html.includes("Enter the amount first."),
      buttons: buttonsOf(html),
    }).toEqual({
      pdf: true,
      reason: true,
      buttons: ["Close", "Enter the amount", "Add invoice", "Cancel bill"],
    });
  });

  it("offers Pay, invoices, paid outside and cancel once the amount is in", () => {
    // #when
    const html = render({ ...bill, amountKes: "4500000" }, true);

    // #then
    expect(buttonsOf(html)).toEqual([
      "Close",
      "Pay",
      "Edit bill",
      "Add invoice",
      "Mark paid outside",
      "Cancel bill",
    ]);
  });

  it("shows an accountant the bill and its invoice with no actions", () => {
    // #when
    const html = render({ ...bill, amountKes: "4500000" }, false);

    // #then
    expect({
      amount: html.includes("KES 45,000.00"),
      pdf: html.includes("paye.pdf"),
      buttons: buttonsOf(html),
    }).toEqual({ amount: true, pdf: true, buttons: ["Close"] });
  });
});
