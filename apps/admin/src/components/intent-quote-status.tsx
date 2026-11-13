import type {
  IntentQuotePurpose,
  IntentQuoteStatus,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { StatusBadge } from "~/components/data/status-badge";

/** What a quote was for, in the words CONTEXT.md gives. */
export const INTENT_QUOTE_PURPOSE_LABELS: Record<IntentQuotePurpose, string> = {
  base_hop: "Base hop",
  usdc_payout: "USDC payout",
  sweep: "Sweep",
  fund_in: "Fund-in",
  fund_in_return: "Fund-in return",
  invoice_payment: "Invoice payment",
  to_treasury: "Move to Treasury",
  from_treasury: "Move to wallet",
  move_in: "Move into confidential account",
};

const TONES: Partial<Record<IntentQuoteStatus, StatusTone>> = {
  needs_review: "waiting",
  depositing: "moving",
  failed: "failed",
  succeeded: "paid",
};

export function IntentQuoteStatusBadge({
  status,
}: {
  status: IntentQuoteStatus;
}) {
  return (
    <StatusBadge tone={TONES[status] ?? "quiet"}>
      {status.replace("_", " ")}
    </StatusBadge>
  );
}
