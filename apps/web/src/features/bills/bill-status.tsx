import type { JSX } from "react";

import type {
  Bill,
  BillHeading,
  BillStatus,
  OverviewHeading,
} from "@expendi-business/shared";

import type { Tone } from "~/features/payment-ui";
import { StatusBadge } from "~/features/payment-ui";
import { formatKesCents } from "~/lib/money";
import { formatBillAmount, kesCentsAtRate } from "./bill-amount";

/** The app's wording (`apps/mobile/src/features/bills/bill-status.tsx`). */
const STATUSES: Record<BillStatus, { label: string; tone: Tone }> = {
  upcoming: { label: "Upcoming", tone: "neutral" },
  due: { label: "Due today", tone: "warning" },
  overdue: { label: "Overdue", tone: "warning" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  payout_failed: { label: "Payment failed", tone: "danger" },
  paid_outside: { label: "Paid outside Expendi", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const HEADING_LABELS: Record<BillHeading, string> = {
  transactions: "Transactions",
  subscriptions: "Subscriptions",
};

const OVERVIEW_HEADING_LABELS: Partial<Record<OverviewHeading, string>> = {
  ...HEADING_LABELS,
  salaries: "Salaries",
};

export function headingLabel(heading: OverviewHeading): string {
  return OVERVIEW_HEADING_LABELS[heading] ?? heading;
}

export function billStatusLabel(status: BillStatus): string {
  return STATUSES[status].label;
}

export function BillStatusBadge({
  status,
}: {
  status: BillStatus;
}): JSX.Element {
  const { label, tone } = STATUSES[status];
  return <StatusBadge label={label} tone={tone} />;
}

const STILL_OWED: readonly BillStatus[] = [
  "upcoming",
  "due",
  "overdue",
  "payout_failed",
  "paying",
];

/**
 * "KES 1,500.00", or for a USD bill "USD 120.50" and, while it's still
 * owed, its KES equivalent at Paycrest's rate now (spec §6.19). A paid USD
 * bill's KES value is fixed on its payment day, which the bill doesn't
 * carry, so none is shown for it.
 */
export function BillAmount({
  bill,
  rate,
}: {
  bill: Pick<Bill, "currency" | "amountKes" | "amountUsdc" | "status">;
  rate: string | null;
}): JSX.Element {
  const amount = formatBillAmount(bill);
  if (amount === null) return <span className="text-stone-500">To enter</span>;
  const kes =
    bill.currency === "usd" &&
    bill.amountUsdc !== null &&
    rate !== null &&
    STILL_OWED.includes(bill.status)
      ? kesCentsAtRate(bill.amountUsdc, rate)
      : null;
  return (
    <span>
      {amount}
      {kes !== null ? (
        <span className="block text-xs font-normal text-stone-500">
          ≈ KES {formatKesCents(kes)} today
        </span>
      ) : null}
    </span>
  );
}
