import type {
  ClaimApproval,
  ClaimPaymentPreview,
  ClaimPaymentResult,
} from "@expendi-business/shared";
import { topUpNeededSchema } from "@expendi-business/shared";

import { ApiError } from "../../lib/api";
import { formatKesCents, formatUsdc } from "../../lib/money";

/**
 * Approve & pay's display logic (spec §6.7): the cost preview's rows, when
 * the prepared passkey challenge can still be signed, the top-up the API
 * asks for, and what a payment's outcome means for the admin.
 */

/** Challenges last 5 minutes; past this, prepare again rather than risk it lapsing mid-prompt. */
export const CHALLENGE_REUSE_MS = 4 * 60_000;

export function isChallengeFresh(preparedAt: number, now: number): boolean {
  return now - preparedAt < CHALLENGE_REUSE_MS;
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

export interface PreviewRow {
  readonly label: string;
  readonly value: string;
}

/** One claim's payment, as the admin confirms it. */
export function previewRows(preview: ClaimPaymentPreview): PreviewRow[] {
  const rounded = preview.claimedKes !== preview.receivesKes;
  return [
    {
      label: "They receive",
      value: `KES ${formatKesCents(preview.receivesKes)}`,
    },
    ...(rounded
      ? [
          {
            label: "Claimed",
            value: `KES ${formatKesCents(preview.claimedKes)}, rounded up to a whole shilling for M-Pesa`,
          },
        ]
      : []),
    {
      label: "Paid to",
      value: `${preview.claimantName}, M-Pesa ending ${preview.phoneLast4}`,
    },
    { label: "USDC", value: `${formatUsdc(preview.usdc)} USDC` },
    {
      label: "Paycrest fee, at most",
      value: `${formatUsdc(preview.feeAllowanceUsdc)} USDC`,
    },
    {
      label: "Total, at most",
      value: `${formatUsdc(preview.maxDebitUsdc)} USDC`,
    },
  ];
}

/** "Top up KES X" when the API refused the payment for a short wallet, else null. */
export function topUpFrom(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = topUpNeededSchema.safeParse(error.details);
  return parsed.success
    ? `Top up KES ${formatKesCents(parsed.data.topUpKes)}, then approve again. Nothing was sent.`
    : null;
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
    title: "Expendi is checking this payment",
    body: "Its outcome isn’t clear yet. Don’t pay it again: Expendi will settle it.",
  },
  failed: {
    title: "The payment failed",
    body: "No money reached M-Pesa, and the USDC stays in or returns to the wallet. You can retry it.",
  },
  paid: {
    title: "Paid",
    body: "The money reached their M-Pesa.",
  },
  sent: {
    title: "Payment sent",
    body: "It usually reaches M-Pesa within a minute or two.",
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
