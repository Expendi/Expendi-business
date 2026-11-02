import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  MeResponse,
  UpdateMeRequest,
  UpdateMeResponse,
} from "@expendi-business/shared";
import { updateMeResponseSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

/** Saves the person's name, then shows it everywhere `useMe` is read. */
export function useUpdateFullName(): UseMutationResult<
  UpdateMeResponse,
  Error,
  UpdateMeRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) => api.patch("/me", request, updateMeResponseSchema),
    onSuccess: (user) => {
      queryClient.setQueriesData<MeResponse>(
        { queryKey: queryKeys.allMe },
        (me) => (me ? { ...me, user } : me),
      );
    },
  });
}
