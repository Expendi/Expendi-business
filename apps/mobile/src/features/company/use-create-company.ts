import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  CreateOrganizationRequest,
  CreateOrganizationResponse,
} from "@expendi-business/shared";
import { createOrganizationResponseSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

export function useCreateCompany(): UseMutationResult<
  CreateOrganizationResponse,
  Error,
  CreateOrganizationRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post("/organizations", request, createOrganizationResponseSchema),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.allMe }),
  });
}
