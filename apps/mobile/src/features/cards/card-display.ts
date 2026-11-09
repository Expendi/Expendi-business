import type {
  CardPurchase,
  CardPurchaseStatus,
  CardState,
  ExpendiCard,
} from "@expendi-business/shared";
import { formatUsdCents } from "@expendi-business/shared";

import { formatKesCents } from "../../lib/money";

export interface CardBadge {
  readonly label: string;
  readonly tone: "neutral" | "success" | "warning";
}

export const CARD_STATE_BADGES: Record<CardState, CardBadge> = {
  open: { label: "Active", tone: "success" },
  frozen: { label: "Frozen", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
};

const PURCHASE_STATUS_BADGES: Record<CardPurchaseStatus, CardBadge> = {
  pending: { label: "Pending", tone: "neutral" },
  settled: { label: "Settled", tone: "success" },
  voided: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  declined: { label: "Declined", tone: "warning" },
};

const RECEIPT_NEEDED_BADGE: CardBadge = {
  label: "Receipt needed",
  tone: "warning",
};
const REFUND_BADGE: CardBadge = { label: "Refund", tone: "success" };

export function maskedCardNumber(lastFour: string): string {
  return `•••• ${lastFour}`;
}

export function spentOfLimit(
  card: Pick<ExpendiCard, "spentThisMonthUsdCents" | "monthlyLimitUsdCents">,
): string {
  const spent = formatUsdCents(BigInt(card.spentThisMonthUsdCents));
  const limit = formatUsdCents(BigInt(card.monthlyLimitUsdCents));
  return `${spent} of ${limit} this month`;
}

/** Only an admin unfreezes, so a holder can freeze a card once. */
export function canFreeze(card: Pick<ExpendiCard, "yours" | "state">): boolean {
  return card.yours && card.state === "open";
}

/** Only the holder, and never on a closed card (spec §6.25). */
export function canShowDetails(
  card: Pick<ExpendiCard, "yours" | "state">,
): boolean {
  return card.yours && card.state !== "closed";
}

export function cardStateNotice(state: CardState): string | null {
  if (state === "frozen") {
    return "This card is frozen. Only an admin can unfreeze it.";
  }
  if (state === "closed") {
    return "This card is closed. You can still see its purchases.";
  }
  return null;
}

type PurchaseAmounts = Pick<
  CardPurchase,
  "kind" | "settledUsdCents" | "holdUsdCents"
>;

/** What it costs so far; null when nothing was ever held, as on a decline. */
export function purchaseAmount(purchase: PurchaseAmounts): string | null {
  const cents =
    BigInt(purchase.settledUsdCents) + BigInt(purchase.holdUsdCents);
  if (cents === 0n) return null;
  const amount = formatUsdCents(cents);
  return purchase.kind === "refund" ? `+${amount}` : amount;
}

/** Set once the Card expense is recorded. */
export function purchaseKes(
  purchase: Pick<CardPurchase, "amountKes">,
): string | null {
  return purchase.amountKes === null
    ? null
    : `KES ${formatKesCents(purchase.amountKes)}`;
}

export function purchaseBadges(
  purchase: Pick<CardPurchase, "kind" | "status" | "needsReceipt">,
): readonly CardBadge[] {
  const status = PURCHASE_STATUS_BADGES[purchase.status];
  if (purchase.kind === "refund") {
    return purchase.status === "settled"
      ? [REFUND_BADGE]
      : [REFUND_BADGE, status];
  }
  return purchase.needsReceipt ? [status, RECEIPT_NEEDED_BADGE] : [status];
}

export function declineNotice(
  purchase: Pick<CardPurchase, "status" | "declineReason">,
): string | null {
  if (purchase.status !== "declined") return null;
  return purchase.declineReason ?? "This purchase was declined.";
}

/** Null when a receipt doesn't apply, as on a refund or a decline. */
export function receiptSummary(
  purchase: Pick<
    CardPurchase,
    "receiptCount" | "needsReceipt" | "noReceiptReason"
  >,
): string | null {
  if (purchase.receiptCount > 0) {
    return purchase.receiptCount === 1
      ? "1 receipt added"
      : `${purchase.receiptCount} receipts added`;
  }
  if (purchase.noReceiptReason) {
    return `Not needed: ${purchase.noReceiptReason}`;
  }
  return purchase.needsReceipt ? "Still needed" : null;
}

const NAIROBI_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Nairobi",
});

/** e.g. "8 Nov 2026": the day it was in Kenya when the card was used. */
export function purchaseDate(authorizedAt: string): string {
  return NAIROBI_DAY.format(new Date(authorizedAt));
}
