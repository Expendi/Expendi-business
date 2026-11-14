import type { ExpenseStatus } from "@expendi-business/shared";

export type ClaimStatusTone = "neutral" | "success" | "attention" | "problem";

/** How a reimbursement's status reads to people, and how loudly. */
export const CLAIM_STATUSES: Record<
  ExpenseStatus,
  { label: string; tone: ClaimStatusTone }
> = {
  submitted: { label: "Waiting for approval", tone: "neutral" },
  rejected: { label: "Returned", tone: "attention" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  payout_failed: { label: "Payment failed", tone: "problem" },
  paid_outside: { label: "Paid before Expendi", tone: "neutral" },
  recorded: { label: "Recorded", tone: "neutral" },
};

export function claimStatusLabel(status: ExpenseStatus): string {
  return CLAIM_STATUSES[status].label;
}
