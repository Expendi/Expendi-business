import type {
  CardBalance,
  CardPurchase,
  CardPurchaseStatus,
  CardState,
  ExpendiCard,
  MembersResponse,
  ReviewCardPurchaseRequest,
} from "@expendi-business/shared";
import {
  CARD_PURCHASE_STATUSES,
  formatUsdCents,
  usdCentsAmountSchema,
} from "@expendi-business/shared";

import type { SortDirection, SortState } from "~/components/data/data-table";
import type { StatusTone } from "~/components/data/status-badge";
import type { CardPurchaseFilters } from "~/lib/query-keys";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import { formatKes } from "~/lib/money";

export const CARD_STATE: Record<
  CardState,
  { readonly label: string; readonly tone: StatusTone }
> = {
  open: { label: "Open", tone: "paid" },
  frozen: { label: "Frozen", tone: "moving" },
  closed: { label: "Closed", tone: "rejected" },
};

export const PURCHASE_STATUS: Record<
  CardPurchaseStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  pending: { label: "Pending", tone: "moving" },
  settled: { label: "Settled", tone: "paid" },
  voided: { label: "Voided", tone: "quiet" },
  expired: { label: "Expired", tone: "quiet" },
  declined: { label: "Declined", tone: "failed" },
};

export const REFUND_NOTE =
  "The money is back in the Card balance. The books aren't adjusted.";

export const CHANGED_AFTER_EXPENSE_NOTE =
  "Its amounts changed after the Card expense was recorded. The books weren't adjusted.";

/** Who holds a card, for people to read; a company-held card has no cardholder. */
export function holderName(
  holder: { readonly name: string | null; readonly email: string } | null,
): string {
  return holder === null ? "Company-held" : personName(holder);
}

/** "•••• 4242"; admins only ever see the last four digits. */
export function maskedLastFour(lastFour: string): string {
  return `•••• ${lastFour}`;
}

/** "Marketing •••• 4242". */
export function cardLabel(card: {
  readonly nickname: string;
  readonly lastFour: string;
}): string {
  return `${card.nickname} ${maskedLastFour(card.lastFour)}`;
}

/**
 * Integer US cents for people to read, e.g. "USD 1,500.50". The Card
 * balance can go below 0 after a late clearing, which `formatUsdCents`
 * doesn't read, so the sign is put back in front.
 */
export function formatUsd(cents: string): string {
  const amount = BigInt(cents);
  return amount < 0n ? `−${formatUsdCents(-amount)}` : formatUsdCents(amount);
}

/** The number alone, for showing the currency code small: "1,500.50". */
export function usdNumber(cents: string): string {
  const amount = BigInt(cents);
  return formatUsdCents(amount < 0n ? -amount : amount).replace(/^USD /, "");
}

export function isBelowZero(balance: CardBalance): boolean {
  return BigInt(balance.availableUsdCents) < 0n;
}

export type CardSortKey = "card" | "holder" | "spent" | "limit";

export const CARD_SORT_FIRST: Record<CardSortKey, SortDirection> = {
  card: "asc",
  holder: "asc",
  spent: "desc",
  limit: "desc",
};

function compareCents(a: string, b: string): number {
  const difference = BigInt(a) - BigInt(b);
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}

/** Ties go A to Z by the card's name. */
export function sortCards(
  cards: readonly ExpendiCard[],
  sort: SortState<CardSortKey>,
): ExpendiCard[] {
  return [...cards].sort((a, b) => {
    const byName = a.nickname.localeCompare(b.nickname);
    let primary = byName;
    if (sort.key === "holder") {
      primary = holderName(a.holder).localeCompare(holderName(b.holder));
    } else if (sort.key === "spent") {
      primary = compareCents(
        a.spentThisMonthUsdCents,
        b.spentThisMonthUsdCents,
      );
    } else if (sort.key === "limit") {
      primary = compareCents(a.monthlyLimitUsdCents, b.monthlyLimitUsdCents);
    }
    return (sort.dir === "asc" ? primary : -primary) || byName;
  });
}

/**
 * Who can hold a card: active admins and employees. The API also refuses
 * anyone who hasn't signed in yet.
 */
export function eligibleCardholders(members: MembersResponse): MembersResponse {
  return members
    .filter(
      (member) =>
        member.status === "active" &&
        (member.role === "admin" || member.role === "employee"),
    )
    .sort((a, b) => personName(a).localeCompare(personName(b)));
}

export type LimitChange =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly direction: "raise" | "lower" };

/**
 * What a new monthly limit means for the card. Raising takes a passkey and
 * lowering doesn't, so the form has to know before it's submitted.
 */
export function limitChangeOf(current: string, typed: string): LimitChange {
  const parsed = usdCentsAmountSchema.safeParse(typed);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? "Enter an amount in US dollars.",
    };
  }
  const limit = BigInt(current);
  if (parsed.data === limit) {
    return {
      ok: false,
      error: `The limit is already ${formatUsd(current)}.`,
    };
  }
  return { ok: true, direction: parsed.data > limit ? "raise" : "lower" };
}

/**
 * A row's USD amount and what's under it. A purchase that has cleared shows
 * what settled, one that hasn't shows the hold. The KES figure appears only
 * once the Card expense is recorded.
 */
export function purchaseAmount(purchase: CardPurchase): {
  readonly cents: string;
  readonly sub: string | null;
} {
  const settled = BigInt(purchase.settledUsdCents);
  const hold = BigInt(purchase.holdUsdCents);
  const notes: string[] = [];
  if (settled > 0n && hold > 0n) {
    notes.push(`${formatUsd(purchase.holdUsdCents)} on hold`);
  } else if (hold > 0n) {
    notes.push("On hold");
  }
  if (purchase.amountKes !== null) {
    notes.push(`KES ${formatKes(purchase.amountKes)}`);
  }
  return {
    cents: settled > 0n ? purchase.settledUsdCents : purchase.holdUsdCents,
    sub: notes.length > 0 ? notes.join(" · ") : null,
  };
}

/**
 * The recurring payment a purchase on a company-held card belongs to, and
 * the bill it paid once it has. The bill is the record, so no receipt is
 * asked for.
 */
export function matchedPaymentOf(purchase: CardPurchase): {
  readonly payeeName: string;
  readonly billId: string | null;
} | null {
  const match = purchase.match;
  if (match?.state !== "matched") return null;
  return {
    payeeName: match.payeeName ?? "its recurring payment",
    billId: match.billId,
  };
}

/** It's waiting for an admin to say what a new merchant's purchase is. */
export function needsAnswer(purchase: CardPurchase): boolean {
  return purchase.match?.state === "needs_review";
}

/** An admin answers a new merchant's purchase once, and can still change a one-off. */
export function canAnswer(purchase: CardPurchase): boolean {
  const state = purchase.match?.state;
  return (
    purchase.kind === "purchase" &&
    (state === "needs_review" || state === "one_off")
  );
}

export const NEEDS_ANSWER = "Needs an answer";

/**
 * The review request for what the admin picked, for the shared schema to
 * check: the recurring payment goes only with `link`, and nothing picked
 * is refused with the schema's own message.
 */
export function answerRequest(
  decision: ReviewCardPurchaseRequest["decision"] | null,
  recurringItemId: string,
): unknown {
  if (decision === null) return {};
  return decision === "link" ? { decision, recurringItemId } : { decision };
}

/**
 * What the sheet says once an answer is saved, from what the API made of
 * it: a link it kept as a one-off, because the purchase's Card expense was
 * already in the books, says so. `payeeName` is the recurring payment the
 * admin picked.
 */
export function answerSavedText(
  request: ReviewCardPurchaseRequest,
  saved: CardPurchase,
  payeeName: string,
): string {
  const state = saved.match?.state;
  if (state === "matched") {
    const payee = saved.match?.payeeName ?? payeeName;
    return `Saved. It pays ${payee}’s bill, and later purchases from ${saved.merchant} match on their own.`;
  }
  if (state === "one_off") {
    return request.decision === "link"
      ? `${payeeName}’s later purchases will pay its bills. This one stays a Card expense because it’s already in your books.`
      : "Saved as a one-off purchase. It stays a Card expense and needs a receipt.";
  }
  if (state === "not_recognised") {
    return `Saved. ${saved.merchant} is declined on ${saved.card.nickname} from now on.`;
  }
  return "Saved.";
}

/** What an admin said about a new merchant's purchase, as its sheet shows it. */
export const ANSWER_LABELS = {
  one_off: "A one-off purchase",
  not_recognised: "Not recognised: this merchant is declined on this card",
} as const;

/** "Needs a receipt" applies to a Card expense; a purchase that pays a bill has none. */
export function asksForReceipt(purchase: CardPurchase): boolean {
  return purchase.needsReceipt && matchedPaymentOf(purchase) === null;
}

/** An admin can waive the receipt only on a recorded Card expense still missing one. */
export function canWaiveReceipt(purchase: CardPurchase): boolean {
  return (
    purchase.kind === "purchase" &&
    purchase.expenseId !== null &&
    asksForReceipt(purchase)
  );
}

/**
 * An admin adds the receipt for a company-held card's purchase, which has
 * no cardholder to add it from the app; the API takes one from the hold on.
 */
export function canAddReceipt(purchase: CardPurchase): boolean {
  return (
    purchase.companyHeld &&
    purchase.kind === "purchase" &&
    (purchase.status === "pending" || purchase.status === "settled") &&
    asksForReceipt(purchase)
  );
}

/** The recurring payments whose Card purchases a frozen card declines: those not paused. */
export function paymentsDeclinedWhenFrozen(
  card: ExpendiCard,
): ExpendiCard["recurringPayments"] {
  return card.recurringPayments.filter((payment) => payment.state === "active");
}

type PurchaseFilterParam = "card" | "status" | "receipt" | "review";

/** The filters as the URL has them, ignoring values the API wouldn't take. */
export function readPurchaseFilters(
  read: (name: PurchaseFilterParam) => string | null,
): CardPurchaseFilters {
  const receipt = read("receipt");
  return {
    cardId: read("card"),
    status:
      CARD_PURCHASE_STATUSES.find((status) => status === read("status")) ??
      null,
    needsReceipt: receipt === "true" || receipt === "false" ? receipt : null,
    needsReview: read("review") === "true" ? "true" : null,
  };
}

export function hasPurchaseFilter(filters: CardPurchaseFilters): boolean {
  return (
    filters.cardId !== null ||
    filters.status !== null ||
    filters.needsReceipt !== null ||
    filters.needsReview !== null
  );
}
