import type { JSX } from "react";

import type {
  Bill,
  BillHeading,
  BillStatus,
  OverviewHeading,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatKes, usdcToKesCents } from "~/lib/money";

/** The app's wording (`apps/mobile/src/features/bills/bill-status.tsx`). */
export const BILL_STATUSES: Readonly<
  Record<BillStatus, { label: string; tone: StatusTone }>
> = {
  upcoming: { label: "Upcoming", tone: "quiet" },
  due: { label: "Due today", tone: "waiting" },
  overdue: { label: "Overdue", tone: "overdue" },
  paying: { label: "Being paid", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  payout_failed: { label: "Payment failed", tone: "failed" },
  paid_outside: { label: "Paid outside Expendi", tone: "paid" },
  cancelled: { label: "Cancelled", tone: "rejected" },
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
  return BILL_STATUSES[status].label;
}

export function BillStatusBadge({
  status,
  className,
}: {
  status: BillStatus;
  className?: string;
}): JSX.Element {
  const { label, tone } = BILL_STATUSES[status];
  return (
    <StatusBadge tone={tone} className={className}>
      {label}
    </StatusBadge>
  );
}

const STILL_OWED: readonly BillStatus[] = [
  "upcoming",
  "due",
  "overdue",
  "payout_failed",
  "paying",
];

/**
 * A bill's amount in its own currency, "To enter" while a variable bill
 * has none. A USD bill still owed also shows its KES at Paycrest's rate now
 * (spec §6.19); a paid one's KES was fixed on its payment day, which the
 * bill doesn't carry, so none is shown.
 */
export function BillAmount({
  bill,
  rate,
  size = "row",
}: {
  bill: Pick<Bill, "currency" | "amountKes" | "amountUsdc" | "status">;
  rate: string | null;
  /** `sheet` sits under the sheet's title, at the header's size. */
  size?: "row" | "sheet";
}): JSX.Element {
  const align = size === "sheet" ? "start" : "end";
  const stackSize = size === "sheet" ? "inherit" : "row";
  if (bill.currency === "usd" && bill.amountUsdc !== null) {
    const kes =
      rate !== null && STILL_OWED.includes(bill.status)
        ? usdcToKesCents(bill.amountUsdc, rate)
        : null;
    return (
      <AmountStack
        align={align}
        size={stackSize}
        sub={kes === null ? null : `≈ KES ${formatKes(kes)} today`}
      >
        <Money amount={bill.amountUsdc} currency="USD" />
      </AmountStack>
    );
  }
  if (bill.currency === "kes" && bill.amountKes !== null) {
    return (
      <AmountStack align={align} size={stackSize}>
        <Money amount={bill.amountKes} currency="KES" />
      </AmountStack>
    );
  }
  return (
    <span
      className={size === "sheet" ? "text-base text-gray-500" : "text-gray-500"}
    >
      To enter
    </span>
  );
}
