import type { JSX } from "react";

import type { ExpenseStatus } from "@expendi-business/shared";

import { Badge } from "~/components/badge";

const STATUSES: Record<
  ExpenseStatus,
  { label: string; tone: "neutral" | "success" | "warning" }
> = {
  submitted: { label: "Waiting for approval", tone: "neutral" },
  rejected: { label: "Rejected", tone: "warning" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  payout_failed: { label: "Payment failed", tone: "warning" },
  paid_outside: { label: "Paid before Expendi", tone: "neutral" },
  recorded: { label: "Recorded", tone: "neutral" },
};

export function ClaimStatusBadge({
  status,
}: {
  status: ExpenseStatus;
}): JSX.Element {
  const { label, tone } = STATUSES[status];
  return <Badge label={label} tone={tone} />;
}
