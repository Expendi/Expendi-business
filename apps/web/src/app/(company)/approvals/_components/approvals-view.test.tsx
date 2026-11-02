import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Claim, ClaimDetail } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { ApprovalsView } from "./approvals-view";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const claim: Claim = {
  id: id(1),
  status: "submitted",
  merchant: "Naivas Supermarket",
  amountKes: "150050",
  spentOn: "2026-10-15",
  description: "Printer paper",
  category: { id: id(2), name: "Office supplies" },
  mpesaCode: "SKL3ABCDEF",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  etimsQrPayload: null,
  etimsStatus: "none",
  rejectedReason: null,
  submittedBy: {
    membershipId: id(3),
    name: "Jane Wanjiku",
    email: "jane@example.com",
    payoutPhoneConfirmed: true,
  },
  approvedAt: null,
  selfApproved: false,
  paidAt: null,
  floatId: null,
  canEdit: false,
  warnings: [
    { code: "older_than_60_days", spentOn: "2026-06-01", ageDays: 136 },
    {
      code: "near_duplicate",
      expenseId: id(4),
      spentOn: "2026-10-14",
      amountKes: "150050",
    },
  ],
  receiptCount: 2,
  createdAt: "2026-10-15T09:00:00.000Z",
  updatedAt: "2026-10-15T09:00:00.000Z",
};

const detail: ClaimDetail = {
  ...claim,
  receipts: [
    {
      id: id(5),
      kind: "photo",
      contentType: "image/jpeg",
      url: "https://r2.example.com/org/receipts/photo.jpg?X-Amz-Signature=abc",
      expiresAt: "2026-10-15T09:15:00.000Z",
    },
    { id: id(6), kind: "sms_text", text: "SKL3ABCDEF Confirmed. Ksh1,500.50" },
  ],
  payout: null,
};

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  const page = {
    pages: [{ claims: [claim], nextCursor: null }],
    pageParams: [null],
  };
  queryClient.setQueryData(queryKeys.claimQueue(ORG, "submitted"), page);
  queryClient.setQueryData(queryKeys.claimQueue(ORG, "payout_failed"), {
    pages: [{ claims: [], nextCursor: null }],
    pageParams: [null],
  });
  queryClient.setQueryData(queryKeys.claim(ORG, claim.id), detail);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <ApprovalsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the approval queue", () => {
  it("shows an admin each claim with its receipt beside it, its warnings, and the actions", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      receiptImage: html.includes("photo.jpg?X-Amz-Signature=abc"),
      sms: html.includes("SKL3ABCDEF Confirmed. Ksh1,500.50"),
      oldWarning: html.includes("136 days before it was recorded"),
      duplicateWarning: html.includes("The same person claimed KES 1,500.50"),
      checkbox: html.includes('type="checkbox"'),
      approve: html.includes("Approve &amp; pay"),
      reject: html.includes(">Reject<"),
    }).toEqual({
      receiptImage: true,
      sms: true,
      oldWarning: true,
      duplicateWarning: true,
      checkbox: true,
      approve: true,
      reject: true,
    });
  });

  it("shows an accountant the same claims and receipts, with no actions", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      receiptImage: html.includes("photo.jpg?X-Amz-Signature=abc"),
      oldWarning: html.includes("136 days before it was recorded"),
      checkbox: html.includes('type="checkbox"'),
      approve: html.includes("Approve &amp; pay"),
      reject: html.includes(">Reject<"),
      buttons: (html.match(/<button/g) ?? []).length,
    }).toEqual({
      receiptImage: true,
      oldWarning: true,
      checkbox: false,
      approve: false,
      reject: false,
      buttons: 0,
    });
  });
});
