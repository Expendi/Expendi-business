import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CreateRecurringItemRequest,
  RecurringItem,
  UpdateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  recurringItemSchema,
  recurringItemsResponseSchema,
} from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

function recurringPath(organizationId: string) {
  return `/organizations/${organizationId}/recurring-items` as const;
}

/** Active first, then paused, then ended. Admins only (spec §4). */
export function useRecurringItems(
  organizationId: string,
): UseQueryResult<RecurringItem[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recurringItemList(organizationId),
    queryFn: () =>
      api.get(recurringPath(organizationId), recurringItemsResponseSchema),
  });
}

export function useRecurringItem(
  organizationId: string,
  itemId: string,
): UseQueryResult<RecurringItem> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recurringItem(organizationId, itemId),
    queryFn: () =>
      api.get(
        `${recurringPath(organizationId)}/${itemId}`,
        recurringItemSchema,
      ),
  });
}

/** Changes to a recurring payment can create bills, so both refresh. */
function useInvalidateRecurring(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.recurringItems(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.bills(organizationId),
      }),
    ]);
}

export function useCreateRecurringItem(
  organizationId: string,
): UseMutationResult<RecurringItem, Error, CreateRecurringItemRequest> {
  const api = useApi();
  const invalidate = useInvalidateRecurring(organizationId);
  return useMutation({
    mutationFn: (item) =>
      api.post(recurringPath(organizationId), item, recurringItemSchema),
    onSuccess: invalidate,
  });
}

export function useUpdateRecurringItem(
  organizationId: string,
  itemId: string,
): UseMutationResult<RecurringItem, Error, UpdateRecurringItemRequest> {
  const api = useApi();
  const invalidate = useInvalidateRecurring(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      api.patch(
        `${recurringPath(organizationId)}/${itemId}`,
        changes,
        recurringItemSchema,
      ),
    onSuccess: invalidate,
  });
}

export type RecurringItemAction = "pause" | "resume" | "end";

export function useRecurringItemAction(
  organizationId: string,
  itemId: string,
): UseMutationResult<RecurringItem, Error, RecurringItemAction> {
  const api = useApi();
  const invalidate = useInvalidateRecurring(organizationId);
  return useMutation({
    mutationFn: (action) =>
      api.post(
        `${recurringPath(organizationId)}/${itemId}/${action}`,
        undefined,
        recurringItemSchema,
      ),
    onSuccess: invalidate,
  });
}
