import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { PaymentStatuses } from "@expendi-business/shared";

import type { PaymentSurface } from "./payment-poll";
import { inFlightCount, refreshedWhenSettled } from "./payment-poll";

/**
 * Fetches again what a payment changes elsewhere, e.g. the wallet balance,
 * once fewer of `statuses` are on their way than before. The query showing
 * them already has the new status from its own polling.
 */
export function useRefreshWhenPaymentsSettle(
  statuses: PaymentStatuses,
  surface: PaymentSurface,
  organizationId: string,
): void {
  const queryClient = useQueryClient();
  const count = inFlightCount(statuses);
  const previous = useRef(count);
  useEffect(() => {
    const settled = count < previous.current;
    previous.current = count;
    if (!settled) return;
    for (const filters of refreshedWhenSettled(surface, organizationId)) {
      void queryClient.invalidateQueries(filters);
    }
  }, [count, surface, organizationId, queryClient]);
}
