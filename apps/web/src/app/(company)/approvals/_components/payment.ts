import { queryOptions } from "@tanstack/react-query";

import type {
  Claim,
  ClaimApproval,
  ClaimPaymentPreview,
  ClaimPaymentResult,
} from "@expendi-business/shared";
import {
  CLAIM_APPROVAL_MAX_CLAIMS,
  CLAIMS_PAGE_MAX_SIZE,
  paymentPollInterval,
} from "@expendi-business/shared";

import type { CustomerApi } from "~/lib/customer-api";
import { describeApprovalError } from "~/lib/approval";
import { queryKeys } from "~/lib/query-keys";

/**
 * Approve & pay's display logic (spec §6.7, §6.8), as the app has it
 * (`apps/mobile/src/features/claims/payment.ts`), for several claims at
 * once: what can be selected, the cost preview, a changed cost, and what
 * the payments' outcome means.
 */

/** Approve & pay for selected claims, or a failed claim's retry. */
export type PaymentRequest =
  | { readonly kind: "approve"; readonly claimIds: readonly string[] }
  | { readonly kind: "retry"; readonly claimId: string };

/** A prepared payment and when it was prepared, to know if its challenge is still good. */
export interface PreparedPayment {
  readonly request: PaymentRequest;
  readonly approval: ClaimApproval;
  readonly preparedAt: number;
}

/**
 * Claims approved and on their way, which the queues don't show: asked
 * about again every few seconds while there are any, so a payment that
 * fails shows up under Payment failed without a reload.
 */
export function payingClaimsQuery(
  api: Pick<CustomerApi, "listClaims">,
  organizationId: string,
) {
  return queryOptions({
    queryKey: queryKeys.claimQueue(organizationId, "paying"),
    queryFn: () =>
      api.listClaims(organizationId, {
        status: "paying",
        limit: CLAIMS_PAGE_MAX_SIZE,
      }),
    refetchInterval: (query) =>
      paymentPollInterval({
        claims: query.state.data?.claims.map((claim) => claim.status),
      }),
  });
}

/** The API returns the same payouts each time, so preparing again never adds one. */
export function preparePayment(
  api: CustomerApi,
  organizationId: string,
  request: PaymentRequest,
): Promise<ClaimApproval> {
  return request.kind === "retry"
    ? api.prepareClaimRetry(organizationId, request.claimId)
    : api.prepareClaimApproval(organizationId, request.claimIds);
}

/** Whether a fresh preparation still costs what the admin reviewed. */
export function sameCost(
  reviewed: ClaimApproval,
  fresh: ClaimApproval,
): boolean {
  return (
    reviewed.totals.maxDebitUsdc === fresh.totals.maxDebitUsdc &&
    reviewed.totals.receivesKes === fresh.totals.receivesKes &&
    reviewed.claims.length === fresh.claims.length
  );
}

/** The cost changed between the review and the passkey prompt; `fresh` is the new one. */
export class CostChangedError extends Error {
  override readonly name = "CostChangedError";

  constructor(readonly fresh: ClaimApproval) {
    super(
      "The cost changed since you reviewed it. Nothing was sent. Review it again.",
    );
  }
}

export function describePaymentError(error: unknown): string {
  return error instanceof CostChangedError
    ? error.message
    : describeApprovalError(error);
}

/** Why a submitted claim can't be paid yet, or null if it can (spec §6.18). */
export function blockedReason(
  claim: Pick<Claim, "submittedBy">,
): string | null {
  if (!claim.submittedBy.payoutPhoneConfirmed) {
    return "Can't be paid until they confirm their M-Pesa number in the app.";
  }
  if (claim.submittedBy.name === null) {
    return "Can't be paid until they add their name in the app.";
  }
  return null;
}

/** Adds or removes a claim; at most `CLAIM_APPROVAL_MAX_CLAIMS` are selected. */
export function toggleSelection(
  selected: readonly string[],
  claimId: string,
): string[] {
  if (selected.includes(claimId)) {
    return selected.filter((id) => id !== claimId);
  }
  return selected.length < CLAIM_APPROVAL_MAX_CLAIMS
    ? [...selected, claimId]
    : [...selected];
}

/** A KES amount (cents) with an optional note after it, a USDC amount, or words. */
export type PreviewValue =
  | { readonly kind: "kes"; readonly cents: string; readonly note?: string }
  | { readonly kind: "usdc"; readonly units: string }
  | { readonly kind: "text"; readonly text: string };

export interface PreviewRow {
  readonly label: string;
  readonly value: PreviewValue;
}

/** One reimbursement's payment, as the admin confirms it (spec §6.7 step 2). */
export function previewRows(preview: ClaimPaymentPreview): PreviewRow[] {
  const rounded = preview.claimedKes !== preview.receivesKes;
  const submitted: PreviewRow[] = rounded
    ? [
        {
          label: "Submitted",
          value: {
            kind: "kes",
            cents: preview.claimedKes,
            note: "rounded up to a whole shilling for M-Pesa",
          },
        },
      ]
    : [];
  return [
    {
      label: "They receive",
      value: { kind: "kes", cents: preview.receivesKes },
    },
    ...submitted,
    {
      label: "Paid to",
      value: {
        kind: "text",
        text: `${preview.claimantName}, M-Pesa ending ${preview.phoneLast4}`,
      },
    },
    { label: "USDC", value: { kind: "usdc", units: preview.usdc } },
    {
      label: "Cash-out fee, at most",
      value: { kind: "usdc", units: preview.feeAllowanceUsdc },
    },
    {
      label: "Total, at most",
      value: { kind: "usdc", units: preview.maxDebitUsdc },
    },
  ];
}

export type PaymentOutcome = "sent" | "paid" | "failed" | "review";

export interface PaymentSummary {
  readonly outcome: PaymentOutcome;
  readonly title: string;
  readonly body: string;
  /** The first failure's reason, for the admin. */
  readonly failureReason: string | null;
}

const SUMMARIES: Record<PaymentOutcome, { title: string; body: string }> = {
  review: {
    title: "Expendi is checking a payment",
    body: "Its outcome isn’t clear yet. Don’t pay it again: Expendi will settle it.",
  },
  failed: {
    title: "A payment failed",
    body: "No money reached M-Pesa for it, and the USDC stays in or returns to the wallet. You can retry it under Payment failed.",
  },
  paid: {
    title: "Paid",
    body: "The money reached their M-Pesa.",
  },
  sent: {
    title: "Payments sent",
    body: "They usually reach M-Pesa within a minute or two.",
  },
};

/** The most serious outcome across the claims paid together comes first. */
export function describePaymentResult(
  result: ClaimPaymentResult,
): PaymentSummary {
  const { claims } = result;
  const failed = claims.find((claim) => claim.payout.status === "failed");
  const outcome: PaymentOutcome = claims.some(
    (claim) => claim.payout.status === "needs_review",
  )
    ? "review"
    : failed
      ? "failed"
      : claims.length > 0 && claims.every((claim) => claim.status === "paid")
        ? "paid"
        : "sent";
  return {
    outcome,
    ...SUMMARIES[outcome],
    failureReason: failed?.payout.failureReason ?? null,
  };
}
