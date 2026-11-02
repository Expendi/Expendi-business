import type {
  PayoutStatus,
  WalletHistoryItem,
  WalletTransactionType,
} from "@expendi-business/shared";

import { formatKesCents, formatUsdc } from "~/lib/money";
import { shortAddress } from "./usdc-amount";

/** The app's wording (`apps/mobile/src/features/wallet/history-display.ts`). */
export const TRANSACTION_TYPE_LABELS: Record<WalletTransactionType, string> = {
  deposit: "Deposit",
  topup: "Top-up",
  refund: "Refund",
  payout: "Payment",
  withdrawal: "Withdrawal",
};

export type Tone = "neutral" | "success" | "warning";

export const PAYOUT_STATUS_LABELS: Record<
  PayoutStatus,
  { readonly label: string; readonly tone: Tone }
> = {
  awaiting_approval: { label: "Waiting for approval", tone: "neutral" },
  approved: { label: "Approved", tone: "neutral" },
  order_created: { label: "Sending", tone: "neutral" },
  funding: { label: "Sending", tone: "neutral" },
  paying: { label: "On its way", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  failed: { label: "Failed", tone: "warning" },
  needs_review: { label: "Being checked", tone: "warning" },
};

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-700",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-100 text-amber-900",
};

/** "+20.00" for money in, "-5.00" for money out. */
export function formatSignedUsdc(baseUnits: string): string {
  const formatted = formatUsdc(baseUnits);
  return formatted.startsWith("-") ? formatted : `+${formatted}`;
}

/**
 * Who or where a row is about: the payee and the KES they received, the
 * allowlist label, or the sender.
 */
export function describeCounterparty(item: WalletHistoryItem): string | null {
  const { payout } = item;
  if (payout?.method === "usdc") {
    return `${payout.recipientName} · ${shortAddress(payout.recipientDetail)}`;
  }
  if (payout) {
    return `KES ${formatKesCents(payout.amountKesCents)} · ${payout.recipientName} · ${payout.recipientDetail}`;
  }
  return item.counterpartyAddress
    ? `From ${shortAddress(item.counterpartyAddress)}`
    : null;
}
