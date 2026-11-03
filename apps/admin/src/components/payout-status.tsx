import type { PayoutStatus } from "@expendi-business/shared";

import { Badge } from "~/components/ui/badge";

const STYLES: Partial<Record<PayoutStatus, string>> = {
  needs_review: "bg-amber-100 text-amber-900",
  failed: "bg-error-50 text-error-700",
  paid: "bg-emerald-50 text-emerald-800",
};

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <Badge variant="secondary" className={STYLES[status]}>
      {status.replace("_", " ")}
    </Badge>
  );
}
