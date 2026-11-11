"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OpsAlert } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import { alertColumns } from "./columns";

/** The alert job checks every minute, so the page follows it. */
const REFRESH_MS = 60_000;

/**
 * Alerts to the Expendi team (spec §6.16). Read-only: an alert opens when
 * its cause appears and resolves once it clears.
 */
export function AlertsView() {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.opsAlerts(),
    queryFn: () => api.alerts.list(),
    refetchInterval: REFRESH_MS,
  });

  return (
    <section className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Alerts"
        subtitle="An alert opens when its cause appears and resolves on its own once the cause clears. Each one is emailed to the alert list once."
      />

      {result.isPending ? (
        <PageLoading label="Loading alerts…" />
      ) : result.isError ? (
        <PageError>{describeApiError(result.error)}</PageError>
      ) : (
        <>
          <AlertsSection title={`Open (${result.data.open.length})`}>
            {result.data.open.length === 0 ? (
              <PageEmpty title="No open alerts.">
                New problems will appear here. This page updates every minute.
              </PageEmpty>
            ) : (
              <AlertsTable alerts={result.data.open} />
            )}
          </AlertsSection>
          <AlertsSection
            title={`Resolved since ${formatNairobiTime(result.data.resolvedSince)} (${result.data.recentlyResolved.length})`}
          >
            {result.data.recentlyResolved.length === 0 ? (
              <PageEmpty title="No recently resolved alerts." />
            ) : (
              <AlertsTable alerts={result.data.recentlyResolved} />
            )}
          </AlertsSection>
          {result.data.truncated ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Showing the latest alerts only; older resolved ones are left out.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function AlertsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      {children}
    </Card>
  );
}

function AlertsTable({ alerts }: { alerts: readonly OpsAlert[] }) {
  const table = useDataTable({
    data: alerts,
    columns: alertColumns,
    getRowId: (alert) => alert.id,
    manual: true,
    paginate: false,
  });
  return <DataTable table={table} caption="Operational alerts" />;
}
