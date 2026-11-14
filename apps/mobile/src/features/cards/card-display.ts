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

type LimitFacts = Pick<
  ExpendiCard,
  "spentThisMonthUsdCents" | "monthlyLimitUsdCents"
>;

/** How full this month's limit is, 0 to 1, for the meter. */
export function limitUsed(card: LimitFacts): number {
  const limit = BigInt(card.monthlyLimitUsdCents);
  const spent = BigInt(card.spentThisMonthUsdCents);
  if (spent >= limit) return 1;
  return Number((spent * 1000n) / limit) / 1000;
}

export function limitLeft(card: LimitFacts): string {
  const left =
    BigInt(card.monthlyLimitUsdCents) - BigInt(card.spentThisMonthUsdCents);
  return `${formatUsdCents(left > 0n ? left : 0n)} left`;
}

/** The number as the card face shows it, before the details are revealed. */
export function cardFaceNumber(lastFour: string): string {
  return `••••  ••••  ••••  ${lastFour}`;
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

/** Under the merchant in a list: the day, then anything that isn't plain settled. */
export function purchaseMeta(
  purchase: Pick<
    CardPurchase,
    "authorizedAt" | "kind" | "status" | "needsReceipt"
  >,
  now: Date,
): string {
  const notes = purchaseBadges(purchase)
    .filter((badge) => badge !== PURCHASE_STATUS_BADGES.settled)
    .map((badge) => badge.label);
  return [purchaseShortDate(purchase.authorizedAt, now), ...notes].join(" · ");
}

export type MerchantKind = "flight" | "stay" | "ride" | "fuel" | "food" | "other";

/** What sort of place took the payment, from its merchant category code. */
export function merchantKind(mcc: string): MerchantKind {
  const code = Number(mcc);
  if ((code >= 3000 && code <= 3350) || code === 4511) return "flight";
  if ((code >= 3501 && code <= 3999) || code === 7011) return "stay";
  if (code === 4121) return "ride";
  if (code === 5541 || code === 5542 || code === 5983) return "fuel";
  if (code >= 5811 && code <= 5814) return "food";
  return "other";
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

const NAIROBI_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Africa/Nairobi",
});

const NAIROBI_YEAR = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  timeZone: "Africa/Nairobi",
});

/** e.g. "12 Nov", with the year only when it wasn't this year in Kenya. */
export function purchaseShortDate(authorizedAt: string, now: Date): string {
  const at = new Date(authorizedAt);
  return NAIROBI_YEAR.format(at) === NAIROBI_YEAR.format(now)
    ? NAIROBI_DAY_MONTH.format(at)
    : NAIROBI_DAY.format(at);
}
