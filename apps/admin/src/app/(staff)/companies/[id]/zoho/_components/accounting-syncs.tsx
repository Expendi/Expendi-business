"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type {
  AccountingSync,
  AccountingSyncStatus,
} from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { syncColumns } from "./syncs-columns";

const TABS: {
  readonly status: AccountingSyncStatus;
  readonly label: string;
}[] = [
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Waiting" },
  { status: "synced", label: "In Zoho" },
];

/**
 * Paid spending on its way to Zoho Books (spec §6.15, §6.17). A failed sync
 * can be retried once its cause is fixed; retrying only queues it again, so
 * nothing is posted twice.
 */
export function AccountingSyncsPanel({
  companyId,
  canAct,
}: {
  companyId: string;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const [status, setStatus] = useState<AccountingSyncStatus>("failed");
  const syncs = useQuery({
    queryKey: queryKeys.zohoSyncs(companyId, { status }),
    queryFn: () => api.zoho.syncs(companyId, { status }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Syncs to Zoho</h2>
        </CardTitle>
        <CardDescription>
          Each paid claim, petty cash and company spending, paid bill and paid
          payroll run becomes one Zoho expense. Syncs wait while the connection
          needs reconnecting, then catch up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Sync status"
        >
          {TABS.map((tab) => (
            <Button
              key={tab.status}
              type="button"
              aria-pressed={tab.status === status}
              variant={tab.status === status ? "secondary" : "ghost"}
              onClick={() => setStatus(tab.status)}
            >
              {tab.label}
              {syncs.data ? ` (${syncs.data.counts[tab.status]})` : ""}
            </Button>
          ))}
        </div>

        {syncs.isPending ? (
          <PageLoading label="Loading accounting syncs…" />
        ) : syncs.isError ? (
          <PageError>{describeApiError(syncs.error)}</PageError>
        ) : syncs.data.syncs.length === 0 ? (
          <PageEmpty
            title={`No ${status === "pending" ? "waiting" : status} syncs.`}
          />
        ) : (
          <SyncsTable
            companyId={companyId}
            syncs={syncs.data.syncs}
            status={status}
            canAct={canAct}
            busy={syncs.isPlaceholderData}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SyncsTable({
  companyId,
  syncs,
  status,
  canAct,
  busy,
}: {
  companyId: string;
  syncs: readonly AccountingSync[];
  status: AccountingSyncStatus;
  canAct: boolean;
  busy: boolean;
}) {
  const columns = useMemo(
    () => syncColumns({ companyId, status, canAct }),
    [companyId, status, canAct],
  );
  const table = useDataTable({
    data: syncs,
    columns,
    getRowId: (sync) => sync.id,
    manual: true,
    paginate: false,
  });
  return (
    <div
      className="mt-4 overflow-hidden rounded-lg border border-border"
      aria-busy={busy}
    >
      <DataTable table={table} caption="Accounting syncs" />
    </div>
  );
}
