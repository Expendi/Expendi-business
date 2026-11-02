import type {
  PayoutStatus,
  WalletHistoryItem,
  WalletTransactionType,
} from "@expendi-business/shared";

import { formatKesCents, formatUsdc } from "~/lib/money";
import { shortAddress } from "./usdc-amount";

export type Tone = "neutral" | "success" | "warning";

export const TRANSACTION_TYPES: Record<
  WalletTransactionType,
  { readonly label: string; readonly icon: string }
> = {
  deposit: { label: "Deposit", icon: "↓" },
  topup: { label: "Top-up", icon: "↓" },
  refund: { label: "Refund", icon: "↺" },
  payout: { label: "Payment", icon: "↑" },
  withdrawal: { label: "Withdrawal", icon: "↗" },
};

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
