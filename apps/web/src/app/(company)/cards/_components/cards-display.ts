import type {
  CardBalance,
  CardPurchase,
  CardPurchaseStatus,
  CardState,
  ExpendiCard,
  MembersResponse,
} from "@expendi-business/shared";
import {
  CARD_PURCHASE_STATUSES,
  formatUsdCents,
  usdCentsAmountSchema,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import type { SortDirection, SortState } from "~/components/data/table";
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
      primary = personName(a.holder).localeCompare(personName(b.holder));
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

/** An admin can waive the receipt only on a recorded Card expense still missing one. */
export function canWaiveReceipt(purchase: CardPurchase): boolean {
  return (
    purchase.kind === "purchase" &&
    purchase.expenseId !== null &&
    purchase.needsReceipt
  );
}

/** The filters as the URL has them, ignoring values the API wouldn't take. */
export function readPurchaseFilters(
  read: (name: "card" | "status" | "receipt") => string | null,
): CardPurchaseFilters {
  const receipt = read("receipt");
  return {
    cardId: read("card"),
    status:
      CARD_PURCHASE_STATUSES.find((status) => status === read("status")) ??
      null,
    needsReceipt: receipt === "true" || receipt === "false" ? receipt : null,
  };
}

export function hasPurchaseFilter(filters: CardPurchaseFilters): boolean {
  return (
    filters.cardId !== null ||
    filters.status !== null ||
    filters.needsReceipt !== null
  );
}
