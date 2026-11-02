import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";

import type { OrganizationResponse } from "@expendi-business/shared";
import { organizationResponseSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

/** A company's name and KRA PIN rarely change. */
const ORGANIZATION_STALE_MS = 10 * 60_000;

export function useOrganization(
  organizationId: string,
): UseQueryResult<OrganizationResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.organization(organizationId),
    queryFn: () =>
      api.get(`/organizations/${organizationId}`, organizationResponseSchema),
    staleTime: ORGANIZATION_STALE_MS,
  });
}
