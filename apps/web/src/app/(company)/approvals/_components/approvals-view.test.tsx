import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  Claim,
  ClaimApproval,
  ClaimDetail,
  ClaimsSummary,
} from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { navCountKeys } from "~/hooks/use-nav-counts";
import { queryKeys } from "~/lib/query-keys";
import { ApprovalsView } from "./approvals-view";
import { ClaimActions, RejectForm } from "./claim-detail";
import { ClaimQueue } from "./claim-queue";
import { PaymentReview } from "./payment-review";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/approvals",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => navigation.params,
}));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const claimOf = (overrides: Partial<Claim> = {}): Claim => ({
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
  ...overrides,
});

const claim = claimOf();
const blocked = claimOf({
  id: id(7),
  merchant: "Uber",
  warnings: [],
  receiptCount: 0,
  submittedBy: { ...claim.submittedBy, payoutPhoneConfirmed: false },
});

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

const summary: ClaimsSummary = {
  waiting: { count: 2, totalKes: "300100" },
  payoutFailed: { count: 1, totalKes: "395000" },
};

const page = (claims: readonly Claim[]) => ({
  pages: [{ claims, nextCursor: null }],
  pageParams: [null],
});

const failedClaim = claimOf({
  id: id(9),
  status: "payout_failed",
  merchant: "Naivas Kilimani",
  warnings: [],
});

function render(
  role: "admin" | "accountant",
  { enrolled = true, url = "" }: { enrolled?: boolean; url?: string } = {},
): string {
  navigation.params = new URLSearchParams(url);
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    queryKeys.claimQueue(ORG, "submitted"),
    page([claim, blocked]),
  );
  queryClient.setQueryData(
    queryKeys.claimQueue(ORG, "payout_failed"),
    page([failedClaim]),
  );
  queryClient.setQueryData(navCountKeys.claimsSummary(ORG), summary);
  queryClient.setQueryData(queryKeys.claim(ORG, claim.id), detail);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
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

/** What a sighted reader sees: tags and screen-reader-only text removed. */
const visibleText = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const textOf = (element: ReactElement) =>
  visibleText(renderToStaticMarkup(element));

describe("the approval queue", () => {
  it("shows an admin the queue, the first reimbursement with its receipt, and the actions", () => {
    // #when
    const html = render("admin");
    const text = visibleText(html);

    // #then
    expect({
      tabs: text.includes("Waiting for approval 2 Payment failed 1"),
      receiptImage: html.includes("photo.jpg?X-Amz-Signature=abc"),
      sms: text.includes("SKL3ABCDEF Confirmed. Ksh1,500.50"),
      oldWarning: text.includes("136 days before it was recorded"),
      duplicateWarning: text.includes(
        "The same person submitted KES 1,500.50 on 14 Oct 2026 too.",
      ),
      submittedBy: text.includes("Jane Wanjiku · jane@example.com"),
      selectAll: text.includes("Select all"),
      checkboxes: (html.match(/type="checkbox"/g) ?? []).length,
      approve: text.includes("Approve & pay"),
      reject: text.includes("Reject"),
      addToSelection: text.includes("Add to selection"),
      bar: text.includes("Select reimbursements to approve and pay."),
      cantPay: text.includes("Can't be paid yet"),
      noReceipt: text.includes("No receipt"),
      noClaimWording: !/claim/i.test(text),
    }).toEqual({
      tabs: true,
      receiptImage: true,
      sms: true,
      oldWarning: true,
      duplicateWarning: true,
      submittedBy: true,
      selectAll: true,
      checkboxes: 3,
      approve: true,
      reject: true,
      addToSelection: true,
      bar: true,
      cantPay: true,
      noReceipt: true,
      noClaimWording: true,
    });
  });

  it("shows an accountant the same reimbursements and receipts, with no actions", () => {
    // #when
    const html = render("accountant");
    const text = visibleText(html);

    // #then
    expect({
      receiptImage: html.includes("photo.jpg?X-Amz-Signature=abc"),
      oldWarning: text.includes("136 days before it was recorded"),
      subtitle: text.includes("Only admins approve and pay."),
      viewOnly: text.includes("View only. Admins approve and pay."),
      waiting: text.includes("2 reimbursements waiting"),
      checkbox: html.includes('type="checkbox"'),
      approve: text.includes("Approve & pay"),
      reject: text.includes("Reject"),
    }).toEqual({
      receiptImage: true,
      oldWarning: true,
      subtitle: true,
      viewOnly: true,
      waiting: true,
      checkbox: false,
      approve: false,
      reject: false,
    });
  });

  it("asks an admin without a passkey to set one up, and still lets them reject", () => {
    // #when
    const html = render("admin", { enrolled: false });
    const text = visibleText(html);

    // #then
    expect({
      banner: text.includes("Set up your approval passkey first"),
      checkbox: html.includes('type="checkbox"'),
      approve: text.includes("Approve & pay"),
      reject: text.includes("Reject"),
    }).toEqual({ banner: true, checkbox: false, approve: false, reject: true });
  });

  it("gives a row that can't be paid no checkbox, keeping its column", () => {
    // #when
    const html = render("admin");
    const row = html.slice(html.indexOf(`data-claim-id="${blocked.id}"`) - 400);

    // #then
    expect({
      selectable: html.includes(
        'aria-label="Select Naivas Supermarket, Jane Wanjiku"',
      ),
      blocked: html.includes('aria-label="Select Uber, Jane Wanjiku"'),
      emptyCell:
        /<li class="[^"]*grid-cols-\[40px_minmax\(0,1fr\)\][^"]*"><span><\/span><button/.test(
          row,
        ),
    }).toEqual({ selectable: true, blocked: false, emptyCell: true });
  });

  it("opens the reimbursement a link names, in its own tab", () => {
    // #when
    const waiting = visibleText(
      render("admin", { url: `claimId=${blocked.id}` }),
    );
    const failed = visibleText(
      render("admin", { url: `claimId=${failedClaim.id}` }),
    );

    // #then
    expect({
      waitingPane: waiting.includes(
        "Uber Jane Wanjiku · jane@example.com KES 1,500.50 Waiting for approval",
      ),
      blockedNote: waiting.includes(
        "Can't be paid until they confirm their M-Pesa number in the app.",
      ),
      failedPane: failed.includes(
        "Naivas Kilimani Jane Wanjiku · jane@example.com KES 1,500.50 Payment failed",
      ),
      failedHint: failed.includes("Paid but didn't arrive. Retry each one."),
      retry: failed.includes("Retry payment"),
    }).toEqual({
      waitingPane: true,
      blockedNote: true,
      failedPane: true,
      failedHint: true,
      retry: true,
    });
  });
});

const queueState = {
  isPending: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  refetch: () => undefined,
  fetchNextPage: () => undefined,
};

describe("the queue", () => {
  it("approves and pays a selection by count, with what it pays back", () => {
    // #when
    const text = textOf(
      <ClaimQueue
        tab="waiting"
        claims={[claim, claimOf({ id: id(8), amountKes: "50000" })]}
        queue={queueState}
        total={summary.waiting}
        activeId={claim.id}
        onActivate={() => undefined}
        canPay
        busy={false}
        selected={[claim.id, id(8)]}
        onSelectedChange={() => undefined}
        onApproveSelected={() => undefined}
        preparing={false}
      />,
    );

    // #then
    expect(
      [
        "2 selected · KES 2,000.50 to pay back",
        "Clear selection",
        "Approve & pay 2",
      ].filter((line) => !text.includes(line)),
    ).toEqual([]);
  });

  it("shows failed payments to retry, and an empty queue", () => {
    // #when
    const failed = textOf(
      <ClaimQueue
        tab="failed"
        claims={[claimOf({ status: "payout_failed", warnings: [] })]}
        queue={queueState}
        total={summary.payoutFailed}
        activeId={null}
        onActivate={() => undefined}
        canPay
        busy={false}
        selected={[]}
        onSelectedChange={() => undefined}
        onApproveSelected={() => undefined}
        preparing={false}
      />,
    );
    const empty = textOf(
      <ClaimQueue
        tab="waiting"
        claims={[]}
        queue={queueState}
        total={undefined}
        activeId={null}
        onActivate={() => undefined}
        canPay
        busy={false}
        selected={[]}
        onSelectedChange={() => undefined}
        onApproveSelected={() => undefined}
        preparing={false}
      />,
    );

    // #then
    expect({
      hint: failed.includes("Paid but didn't arrive. Retry each one."),
      badge: failed.includes("Payment failed"),
      noSelection: !failed.includes("Approve & pay"),
      empty: empty.includes("Nothing to approve"),
    }).toEqual({ hint: true, badge: true, noSelection: true, empty: true });
  });

  it("retries a failed payment, or says it needs the passkey", () => {
    // #given
    const actions = (canPay: boolean) =>
      textOf(
        <ClaimActions
          claim={claim}
          tab="failed"
          canAct
          canPay={canPay}
          busy={false}
          preparing={false}
          selected={false}
          selectionFull={false}
          rejecting={false}
          onApprove={() => undefined}
          onRetry={() => undefined}
          onToggleSelected={() => undefined}
          onStartReject={() => undefined}
          rejectForm={null}
        />,
      );

    // #then
    expect([actions(true), actions(false)].map((text) => text.trim())).toEqual([
      "Retry payment",
      "Retrying needs your approval passkey.",
    ]);
  });

  it("asks why a reimbursement is rejected", () => {
    // #when
    const text = textOf(
      <QueryClientProvider client={new QueryClient()}>
        <RejectForm
          organizationId={ORG}
          claim={claim}
          onCancel={() => undefined}
          onRejected={() => undefined}
        />
      </QueryClientProvider>,
    );

    // #then
    expect(
      [
        "Why are you rejecting it? They'll see this.",
        "Jane gets this in the app.",
        "0/500",
        "Reject reimbursement",
        "Cancel",
      ].filter((line) => !text.includes(line)),
    ).toEqual([]);
  });
});

const approval: ClaimApproval = {
  challengeId: id(90),
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  claims: [
    {
      claimId: claim.id,
      payoutId: id(91),
      claimantName: "Jane Wanjiku",
      phoneLast4: "5678",
      claimedKes: "150050",
      receivesKes: "150100",
      rate: "128.68",
      usdc: "11664595",
      feeAllowanceUsdc: "116646",
      maxDebitUsdc: "11781241",
    },
  ],
  totals: {
    receivesKes: "150100",
    usdc: "11664595",
    feeAllowanceUsdc: "116646",
    maxDebitUsdc: "11781241",
  },
  wallet: { availableUsdc: "100000000", shortfallUsdc: "0", topUpKes: null },
};

describe("the payment review", () => {
  it("shows what each person receives, the totals and the passkey step", () => {
    // #when
    const text = textOf(
      <PaymentReview
        approval={approval}
        merchantOf={() => "Naivas Supermarket"}
        costChanged={false}
        cancelled={false}
      />,
    );

    // #then
    expect(
      [
        "Jane Wanjiku Naivas Supermarket KES 1,501",
        "They receive KES 1,501",
        "Submitted KES 1,500.50",
        "rounded up to a whole shilling for M-Pesa",
        "Paid to Jane Wanjiku, M-Pesa ending 5678",
        "Total, at most 11.781241 USDC",
        "In the wallet 100.00 USDC",
        "Each one is paid on its own.",
        "use a phone or tablet",
      ].filter((line) => !text.includes(line)),
    ).toEqual([]);
  });

  it("asks for a top-up, a second look after a cost change, and says a cancel sent nothing", () => {
    // #when
    const text = textOf(
      <PaymentReview
        approval={{
          ...approval,
          wallet: {
            availableUsdc: "1000000",
            shortfallUsdc: "10781241",
            topUpKes: "140000",
          },
        }}
        merchantOf={() => undefined}
        costChanged
        cancelled
      />,
    );

    // #then
    expect(
      [
        "The cost changed since you reviewed it. Nothing was sent.",
        "Top up KES 1,400",
        "Go to Accounts",
        "Cancelled. Nothing was sent.",
      ].filter((line) => !text.includes(line)),
    ).toEqual([]);
  });
});
