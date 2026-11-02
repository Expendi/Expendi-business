import type { JSX } from "react";

import type { BillHeading, BillStatus } from "@expendi-business/shared";

import { Badge } from "~/components/badge";

const STATUSES: Record<
  BillStatus,
  { label: string; tone: "neutral" | "success" | "warning" }
> = {
  upcoming: { label: "Upcoming", tone: "neutral" },
  due: { label: "Due today", tone: "warning" },
  overdue: { label: "Overdue", tone: "warning" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  payout_failed: { label: "Payment failed", tone: "warning" },
  paid_outside: { label: "Paid outside Expendi", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const HEADING_LABELS: Record<BillHeading, string> = {
  transactions: "Transactions",
  subscriptions: "Subscriptions",
};

export function BillStatusBadge({
  status,
}: {
  status: BillStatus;
}): JSX.Element {
  const { label, tone } = STATUSES[status];
  return <Badge label={label} tone={tone} />;
}
