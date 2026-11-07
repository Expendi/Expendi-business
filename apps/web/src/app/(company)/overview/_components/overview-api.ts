"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type {
  FloatsResponse,
  ReportSpending,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  floatsResponseSchema,
  reportSpendingSchema,
} from "@expendi-business/shared";

import { useAuth } from "~/contexts/auth-context";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";

/** The months the overview's money-out chart shows. */
export const TREND_MONTHS = 6;

export const overviewKeys = {
  month: (organizationId: string, month: string | undefined) =>
    ["overview", organizationId, "month", month ?? "current"] as const,
  openFloats: (organizationId: string) =>
    ["overview", organizationId, "floats", "open"] as const,
  trend: (organizationId: string, month: string) =>
    ["overview", organizationId, "trend", month, TREND_MONTHS] as const,
};

/** `GET /overview` for `month`: the inbox, the cash check and the month's spending. */
export function useOverview(
  organizationId: string,
  month: string,
): UseQueryResult<SpendingOverview> {
  const { api } = useAuth();
  return useQuery({
    queryKey: overviewKeys.month(organizationId, month),
    queryFn: () => api.getOverview(organizationId, month),
    placeholderData: keepPreviousData,
  });
}

/** Open petty cash floats, for what each holder has left. */
export function useOpenFloats(
  organizationId: string,
): UseQueryResult<FloatsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: overviewKeys.openFloats(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/floats?status=open`,
        floatsResponseSchema,
      ),
  });
}

/** Money out by month and category up to `month`, from the reports API. */
export function useSpendingTrend(
  organizationId: string,
  month: string,
): UseQueryResult<ReportSpending> {
  const api = useApi();
  return useQuery({
    queryKey: overviewKeys.trend(organizationId, month),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/reports/spending?month=${month}&months=${String(TREND_MONTHS)}`,
        reportSpendingSchema,
      ),
    placeholderData: keepPreviousData,
  });
}

/** The signed-in person's full name, from the `/me` query the shell already made. */
export function useViewerName(): string | null {
  const { api, privyUserId } = useAuth();
  const me = useQuery({
    queryKey: queryKeys.me(privyUserId ?? ""),
    queryFn: () => api.getMe(),
  });
  return me.data?.user.fullName ?? null;
}
