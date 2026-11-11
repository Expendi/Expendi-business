import type {
  IntentQuotePurpose,
  IntentQuoteStatus,
} from "@expendi-business/shared";

import { Badge } from "~/components/ui/badge";

/** What a quote was for, in the words CONTEXT.md gives. */
export const INTENT_QUOTE_PURPOSE_LABELS: Record<IntentQuotePurpose, string> = {
  base_hop: "Base hop",
  usdc_payout: "USDC payout",
  sweep: "Sweep",
  fund_in: "Fund-in",
};

const STYLES: Partial<Record<IntentQuoteStatus, string>> = {
  needs_review: "bg-amber-100 text-amber-900",
  failed: "bg-error-50 text-error-700",
  succeeded: "bg-emerald-50 text-emerald-800",
};

export function IntentQuoteStatusBadge({
  status,
}: {
  status: IntentQuoteStatus;
}) {
  return (
    <Badge variant="secondary" className={STYLES[status]}>
      {status.replace("_", " ")}
    </Badge>
  );
}
