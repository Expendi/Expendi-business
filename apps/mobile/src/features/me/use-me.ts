import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";

import type { MeResponse } from "@expendi-business/shared";
import { meResponseSchema } from "@expendi-business/shared";

import { useAuth } from "~/features/auth/auth-provider";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

export function useMe(): UseQueryResult<MeResponse> {
  const api = useApi();
  const { status, privyUserId } = useAuth();
  return useQuery({
    queryKey: queryKeys.me(privyUserId),
    queryFn: () => api.get("/me", meResponseSchema),
    enabled: status === "signed-in",
  });
}
