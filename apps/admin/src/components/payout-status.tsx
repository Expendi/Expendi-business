import type { PayoutStatus } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { StatusBadge } from "~/components/data/status-badge";

const TONES: Partial<Record<PayoutStatus, StatusTone>> = {
  needs_review: "waiting",
  failed: "failed",
  paid: "paid",
};

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <StatusBadge tone={TONES[status] ?? "quiet"}>
      {status.replace("_", " ")}
    </StatusBadge>
  );
}
