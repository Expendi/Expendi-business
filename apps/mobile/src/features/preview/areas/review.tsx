/** DEV PREVIEW — reimbursement review and the approvals queue. */
import type { JSX } from "react";

import type { Claim, ClaimDetail } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import type { PreviewArea, PreviewRoute, PreviewScreen } from "../types";
import { useClaimQueue } from "~/features/claims/use-claim-approval";
import { ApprovalsScreen } from "~/features/review/approvals-screen";
import { ClaimDetailScreen } from "~/features/review/review-screen";
import { PREVIEW_OVERVIEW } from "../overview-fixture";
import { PREVIEW_ORG_ID, previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const BRIAN_CLAIM_ID = "7f3c2a10-5b4d-4e8f-9a61-3c2d1e0f9a01";
const ACHIENG_CLAIM_ID = "7f3c2a10-5b4d-4e8f-9a61-3c2d1e0f9a02";
const KEVIN_CLAIM_ID = "7f3c2a10-5b4d-4e8f-9a61-3c2d1e0f9a03";
const EARLIER_CLAIM_ID = "7f3c2a10-5b4d-4e8f-9a61-3c2d1e0f9a04";
const CATEGORY_ID = "5d1e3b20-6c4f-4f9a-8b72-4d3e2f1a0b01";
const BRIAN_MEMBER_ID = "9d2e4c1a-7b3f-4a6e-8d5c-0f1e2a3b4c02";

const OVERVIEW = /\/overview(\?|$)/;
const CLAIM_DETAIL = /\/claims\/[0-9a-f-]{36}$/;
const QUEUE_WAITING = /\/claims\?status=submitted/;
const QUEUE_FAILED = /\/claims\?status=payout_failed/;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: BRIAN_CLAIM_ID,
    status: "submitted",
    merchant: "Kahawa Corner",
    amountKes: "124000",
    spentOn: "2026-11-04",
    description: "Coffee with Tausi from Nuru Foods about the Q1 pilot.",
    category: { id: CATEGORY_ID, name: "Meals & entertainment" },
    mpesaCode: "SK4R7T1MNB",
    etimsInvoiceNumber: null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: "not_required",
    rejectedReason: null,
    floatId: null,
    submittedBy: {
      membershipId: BRIAN_MEMBER_ID,
      name: "Brian Otieno",
      email: "brian@mawingulabs.co.ke",
      payoutPhoneConfirmed: true,
    },
    approvedAt: null,
    selfApproved: false,
    paidAt: null,
    canEdit: false,
    warnings: [],
    receiptCount: 1,
    createdAt: daysAgoIso(2),
    updatedAt: daysAgoIso(2),
    ...overrides,
  };
}

const SMS_RECEIPT = {
  id: "2e4a6c80-1b3d-4f5a-9c7e-0a1b2c3d4e01",
  kind: "sms_text",
  text: "SK4R7T1MNB Confirmed. Ksh1,240.00 paid to KAHAWA CORNER. on 4/11/26 at 1:15 PM.",
} as const;

function detail(overrides: Partial<ClaimDetail> = {}): ClaimDetail {
  return { ...claim(), receipts: [SMS_RECEIPT], payout: null, ...overrides };
}

const QUEUE: Claim[] = [
  claim(),
  claim({
    id: ACHIENG_CLAIM_ID,
    merchant: "Naivas Westlands",
    amountKes: "325000",
    spentOn: "2026-11-07",
    createdAt: daysAgoIso(1),
    submittedBy: {
      membershipId: "9d2e4c1a-7b3f-4a6e-8d5c-0f1e2a3b4c03",
      name: "Achieng' Odhiambo",
      email: "achieng@mawingulabs.co.ke",
      payoutPhoneConfirmed: true,
    },
  }),
  claim({
    id: KEVIN_CLAIM_ID,
    merchant: "Java House Kilimani",
    amountKes: "687000",
    spentOn: "2026-11-05",
    createdAt: daysAgoIso(4),
    warnings: [
      {
        code: "near_duplicate",
        expenseId: EARLIER_CLAIM_ID,
        spentOn: "2026-11-05",
        amountKes: "687000",
      },
    ],
    submittedBy: {
      membershipId: "9d2e4c1a-7b3f-4a6e-8d5c-0f1e2a3b4c04",
      name: "Kevin Mwangi",
      email: "kevin@mawingulabs.co.ke",
      payoutPhoneConfirmed: false,
    },
  }),
];

const page = (claims: Claim[]) => ({ claims, nextCursor: null });
const route = (path: RegExp, data: unknown): PreviewRoute => ({ path, data });

const queueRoutes = (claims: Claim[]): PreviewRoute[] => [
  route(QUEUE_WAITING, page(claims)),
  route(QUEUE_FAILED, page([])),
];

/** Loads the queue first, as arriving from the approvals list would. */
function WarmQueue({ children }: { children: JSX.Element }): JSX.Element {
  useClaimQueue(PREVIEW_ORG_ID, "submitted");
  return children;
}

function companyOf(role: "admin" | "employee"): Company {
  const { state } = previewSession(role);
  if (state.status !== "ready") throw new Error("preview session");
  return state.company;
}

function ReviewPreview({
  claimId,
  role = "admin",
}: {
  claimId: string;
  role?: "admin" | "employee";
}): JSX.Element {
  const screen = (
    <ClaimDetailScreen company={companyOf(role)} claimId={claimId} />
  );
  return role === "admin" ? <WarmQueue>{screen}</WarmQueue> : screen;
}

function review(
  claimId: string,
  role?: "admin" | "employee",
): () => JSX.Element {
  function Render(): JSX.Element {
    return <ReviewPreview claimId={claimId} role={role} />;
  }
  return Render;
}

const Approvals = (): JSX.Element => (
  <ApprovalsScreen company={companyOf("admin")} />
);

const DETAIL_PATH = CLAIM_DETAIL;

const screens: PreviewScreen[] = [
  {
    key: "review",
    name: "Review",
    role: "admin",
    routes: [route(DETAIL_PATH, detail()), ...queueRoutes(QUEUE)],
    render: review(BRIAN_CLAIM_ID),
  },
  {
    key: "review-duplicate",
    name: "Review · duplicate",
    role: "admin",
    routes: [
      route(
        DETAIL_PATH,
        detail({
          id: KEVIN_CLAIM_ID,
          merchant: "Java House Kilimani",
          amountKes: "687000",
          warnings: QUEUE[2]?.warnings ?? [],
          submittedBy: QUEUE[2]?.submittedBy ?? claim().submittedBy,
        }),
      ),
      ...queueRoutes(QUEUE),
    ],
    render: review(KEVIN_CLAIM_ID),
  },
  {
    key: "review-short",
    name: "Review · short",
    role: "admin",
    routes: [
      route(DETAIL_PATH, detail()),
      route(OVERVIEW, {
        ...PREVIEW_OVERVIEW,
        cash: { ...PREVIEW_OVERVIEW.cash, availableKes: "50000" },
      }),
      ...queueRoutes(QUEUE),
    ],
    render: review(BRIAN_CLAIM_ID),
  },
  {
    key: "review-employee",
    name: "Review · returned (employee)",
    role: "employee",
    routes: [
      route(
        DETAIL_PATH,
        detail({
          status: "rejected",
          canEdit: true,
          rejectedReason:
            "The M-Pesa message is for a different amount. Paste the right one and resubmit.",
        }),
      ),
    ],
    render: review(BRIAN_CLAIM_ID, "employee"),
  },
  {
    key: "approvals",
    name: "Approvals",
    role: "admin",
    routes: queueRoutes(QUEUE),
    render: Approvals,
  },
  {
    key: "approvals-empty",
    name: "Approvals · empty",
    role: "admin",
    routes: queueRoutes([]),
    render: Approvals,
  },
  {
    key: "approvals-error",
    name: "Approvals · error",
    role: "admin",
    routes: [
      route(QUEUE_WAITING, PREVIEW_FAIL),
      route(QUEUE_FAILED, PREVIEW_FAIL),
    ],
    render: Approvals,
  },
  {
    key: "approvals-loading",
    name: "Approvals · loading",
    role: "admin",
    routes: [
      route(QUEUE_WAITING, PREVIEW_PENDING),
      route(QUEUE_FAILED, PREVIEW_PENDING),
    ],
    render: Approvals,
  },
];

export const REVIEW_AREA: PreviewArea = { routes: [], screens };
