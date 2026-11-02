"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";

import type { CategoriesResponse } from "@expendi-business/shared";

import { useAuth } from "~/contexts/auth-context";
import { queryKeys } from "~/lib/query-keys";

/** The company's categories that can be picked, A to Z. */
export function useCategories(
  organizationId: string,
): UseQueryResult<CategoriesResponse> {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });
}
