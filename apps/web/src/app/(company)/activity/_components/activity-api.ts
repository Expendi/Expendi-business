"use client";

import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { ActivityPage } from "@expendi-business/shared";
import {
  ACTIVITY_PAGE_SIZE,
  activityPageSchema,
} from "@expendi-business/shared";

import { useApi } from "~/lib/use-api";

/** `GET …/activity`'s filters, as the dashboard sends them. */
export interface ActivityFilters {
  readonly actionPrefix?: string;
  readonly actor?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly from?: string;
  readonly to?: string;
}

export const activityKeys = {
  list: (organizationId: string, filters: ActivityFilters) =>
    ["activity", organizationId, filters] as const,
};

function activityPath(
  organizationId: string,
  filters: ActivityFilters,
  cursor: string | null,
): `/${string}` {
  const params = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return `/organizations/${organizationId}/activity?${params.toString()}`;
}

/**
 * The company's audit log, newest first, a page at a time. With a person
 * or record filter a page can come back short, or empty, with more after
 * it: the view keeps loading while `nextCursor` is set.
 */
export function useActivity(
  organizationId: string,
  filters: ActivityFilters,
): UseInfiniteQueryResult<InfiniteData<ActivityPage, string | null>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: activityKeys.list(organizationId, filters),
    queryFn: ({ pageParam }): Promise<ActivityPage> =>
      api.get(
        activityPath(organizationId, filters, pageParam),
        activityPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}
