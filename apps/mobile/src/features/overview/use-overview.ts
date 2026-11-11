import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";

import type { SpendingOverview } from "@expendi-business/shared";
import { spendingOverviewSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

/** The company overview (spec §6.24); `month` is `YYYY-MM`, or "" for this month. */
export function useOverview(
  organizationId: string,
  month = "",
): UseQueryResult<SpendingOverview> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.overview(organizationId, month),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/overview${month ? `?month=${month}` : ""}`,
        spendingOverviewSchema,
      ),
  });
}
