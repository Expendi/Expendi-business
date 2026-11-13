import type { Bill, BillStatus } from "@expendi-business/shared";

import type { StopFields, StoppedCardState } from "./bill-card";
import { maskedCardNumber } from "../cards/card-display";
import { cardDeclined, payingCard, stoppedCardState } from "./bill-card";

export interface BillBadge {
  readonly label: string;
  readonly tone: "neutral" | "success" | "warning";
}

export const BILL_STATUS_BADGES: Record<BillStatus, BillBadge> = {
  upcoming: { label: "Upcoming", tone: "neutral" },
  due: { label: "Due today", tone: "warning" },
  overdue: { label: "Overdue", tone: "warning" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  payout_failed: { label: "Payment failed", tone: "warning" },
  paid_outside: { label: "Paid outside Expendi", tone: "success" },
  paid_by_card: { label: "Paid by card", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const STOPPED_CARD_BADGES: Record<StoppedCardState, BillBadge> = {
  frozen: { label: "Card frozen", tone: "warning" },
  closed: { label: "Card closed", tone: "warning" },
};

export type BadgeFields = StopFields & Pick<Bill, "cardDeclinedAt">;

/**
 * Its status, then the company-held card that pays it and a decline still
 * to sort out. A paused payment's Card purchases are declined, and an
 * ended one's but for its last bill, as are a frozen or closed card's, so
 * none of them is labelled Automatic; a frozen or closed card is named
 * instead, since someone has to act on it.
 */
export function billBadges(bill: BadgeFields): BillBadge[] {
  const card = payingCard(bill);
  const stopped = stoppedCardState(bill);
  return [
    BILL_STATUS_BADGES[bill.status],
    ...(card === null
      ? []
      : [
          {
            label: `Automatic · card ${maskedCardNumber(card.lastFour)}`,
            tone: "neutral" as const,
          },
        ]),
    ...(stopped === null ? [] : [STOPPED_CARD_BADGES[stopped]]),
    ...(cardDeclined(bill)
      ? [{ label: "Card declined", tone: "warning" as const }]
      : []),
  ];
}
