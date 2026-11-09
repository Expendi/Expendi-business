"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import type {
  AccountingSync,
  AccountingSyncStatus,
  ExpenseKind,
} from "@expendi-business/shared";

import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

const TABS: {
  readonly status: AccountingSyncStatus;
  readonly label: string;
}[] = [
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Waiting" },
  { status: "synced", label: "In Zoho" },
];

const SUBJECT_LABELS: Record<AccountingSync["subjectType"], string> = {
  expense: "Spending",
  bill: "Bill",
  payroll_run: "Payroll run",
};

const EXPENSE_LABELS: Record<ExpenseKind, string> = {
  claim: "Claim",
  float: "Petty cash",
  company: "Company spending",
  card: "Expendi card",
};

function subjectLabel({ subjectType, subject }: AccountingSync): string {
  return subject
    ? `${EXPENSE_LABELS[subject.expenseKind]} · ${subject.label}`
    : SUBJECT_LABELS[subjectType];
}

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
          <div
            className="mt-4 overflow-hidden rounded-lg border border-border"
            aria-busy={syncs.isPlaceholderData}
          >
            <Table aria-label="Accounting syncs">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Tries</TableHead>
                  <TableHead>
                    {status === "synced" ? "Zoho expense" : "Last error"}
                  </TableHead>
                  <TableHead>Updated</TableHead>
                  {canAct && status === "failed" ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncs.data.syncs.map((sync) => (
                  <SyncRow
                    key={sync.id}
                    companyId={companyId}
                    sync={sync}
                    canRetry={canAct && sync.status === "failed"}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SyncRow({
  companyId,
  sync,
  canRetry,
}: {
  companyId: string;
  sync: AccountingSync;
  canRetry: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.zoho.requeueSync(companyId, sync.id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.zohoSyncs(companyId),
      }),
  });

  return (
    <TableRow>
      <TableCell className="min-w-48 max-w-72 break-words whitespace-normal">
        <p className="font-medium">{subjectLabel(sync)}</p>
        <p className="text-xs text-stone-500">
          {sync.subject?.date ?? ""} {sync.subjectId}
        </p>
      </TableCell>
      <TableCell className="tabular-nums">
        {sync.subject ? formatKesCents(sync.subject.amountKesCents) : "—"}
      </TableCell>
      <TableCell>{sync.attempts}</TableCell>
      <TableCell className="min-w-48 max-w-80 break-words whitespace-normal">
        {sync.status === "synced" ? (
          <span>
            {sync.externalId}
            {sync.receiptAttached ? " · receipt attached" : " · no receipt"}
          </span>
        ) : (
          <span className="text-stone-700">{sync.lastError ?? "—"}</span>
        )}
      </TableCell>
      <TableCell>{formatNairobiTime(sync.updatedAt)}</TableCell>
      {canRetry ? (
        <TableCell>
          <Button
            type="button"
            variant="outline"
            disabled={retry.isPending || retry.isSuccess}
            onClick={() => retry.mutate()}
          >
            {retry.isSuccess ? "Queued" : "Retry"}
          </Button>
          {retry.isError ? (
            <p role="alert" className="mt-1 text-xs text-error-700">
              {describeApiError(retry.error)}
            </p>
          ) : null}
        </TableCell>
      ) : null}
    </TableRow>
  );
}
