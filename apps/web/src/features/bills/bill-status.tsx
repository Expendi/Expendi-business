import type { JSX } from "react";

import type {
  Bill,
  BillDetail,
  BillHeading,
  BillStatus,
  OverviewHeading,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatKes, usdcToKesCents } from "~/lib/money";
import { automaticCardOf, cardWontPayReason } from "./bill-payment";

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
  paid_by_card: { label: "Paid by card", tone: "paid" },
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

/** "•••• 1234": only ever the last four digits. */
export const lastFourOf = (card: { readonly lastFour: string }): string =>
  `•••• ${card.lastFour}`;

export function CardDeclinedBadge({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <StatusBadge tone="failed" className={className}>
      Card declined
    </StatusBadge>
  );
}

const STOPPED_CARD_LABELS = {
  frozen: "Card frozen",
  closed: "Card closed",
} as const;

/**
 * Beside a bill's status: "Automatic · card •••• 1234" while a
 * company-held card is to pay it, "Card declined" once the card declined
 * the purchase meant for it. A frozen or closed card declines every
 * purchase, so it's named instead, since someone has to act on it. Nothing
 * once the card won't pay it (`cardWontPayReason`): its recurring payment
 * is paused, or has ended and is paused too. An ended one's last bill still
 * owed is paid as usual.
 */
export function CardBillBadge({
  bill,
  className,
}: {
  bill: Bill;
  className?: string;
}): JSX.Element | null {
  const card = automaticCardOf(bill);
  if (card === null) return null;
  if (card.state === "frozen" || card.state === "closed") {
    return (
      <StatusBadge tone="waiting" className={className}>
        {STOPPED_CARD_LABELS[card.state]}
      </StatusBadge>
    );
  }
  if (cardWontPayReason(bill) !== null) return null;
  return bill.cardDeclinedAt ? (
    <CardDeclinedBadge className={className} />
  ) : (
    <StatusBadge tone="moving" className={className}>
      Automatic · card {lastFourOf(card)}
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
 * has none. A USD bill still owed also shows its KES at today's rate
 * (spec §6.19); a paid one's KES was fixed on its payment day, which only
 * the bill's detail carries, and only one paid by card shows it. A
 * company-held card's bill still owed has an estimate in a row ("About
 * USD 20.00"), or "No estimate".
 */
export function BillAmount({
  bill,
  rate,
  size = "row",
}: {
  bill: Pick<
    Bill,
    "currency" | "amountKes" | "amountUsdc" | "status" | "card"
  > &
    Partial<Pick<BillDetail, "paidAmountKes">>;
  rate: string | null;
  /** `sheet` sits under the sheet's title, at the header's size. */
  size?: "row" | "sheet";
}): JSX.Element {
  const align = size === "sheet" ? "start" : "end";
  const stackSize = size === "sheet" ? "inherit" : "row";
  const byCard = automaticCardOf(bill) !== null;
  if (bill.currency === "usd" && bill.amountUsdc !== null) {
    const kes =
      rate !== null && STILL_OWED.includes(bill.status)
        ? usdcToKesCents(bill.amountUsdc, rate)
        : null;
    const settledKes =
      bill.status === "paid_by_card" && bill.paidAmountKes != null
        ? `KES ${formatKes(bill.paidAmountKes)}`
        : null;
    return (
      <AmountStack
        align={align}
        size={stackSize}
        sub={kes === null ? settledKes : `≈ KES ${formatKes(kes)} today`}
      >
        {byCard && size === "row" ? (
          <span className="font-(--w-ui) text-muted-foreground">About </span>
        ) : null}
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
      className={
        size === "sheet"
          ? "text-base text-muted-foreground"
          : "text-muted-foreground"
      }
    >
      {byCard ? "No estimate" : "To enter"}
    </span>
  );
}
