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

import {
  cellClass,
  headCellClass,
  secondaryButton,
  tableClass,
} from "~/components/styles";
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
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <h2 className="text-base font-semibold">Syncs to Zoho</h2>
      <p className="mt-1 text-sm text-stone-600">
        Each paid claim, petty cash and company spending, paid bill and paid
        payroll run becomes one Zoho expense. Syncs wait while the connection
        needs reconnecting, then catch up.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={tab.status === status}
            className={`${secondaryButton} ${tab.status === status ? "bg-stone-100" : ""}`}
            onClick={() => setStatus(tab.status)}
          >
            {tab.label}
            {syncs.data ? ` (${syncs.data.counts[tab.status]})` : ""}
          </button>
        ))}
      </div>

      {syncs.isPending ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : syncs.isError ? (
        <p role="alert" className="mt-3 text-sm text-error-700">
          {describeApiError(syncs.error)}
        </p>
      ) : syncs.data.syncs.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">Nothing here.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className={tableClass}>
            <thead className="border-b border-stone-200 text-stone-500">
              <tr>
                <th className={headCellClass}>Item</th>
                <th className={headCellClass}>Amount</th>
                <th className={headCellClass}>Tries</th>
                <th className={headCellClass}>
                  {status === "synced" ? "Zoho expense" : "Last error"}
                </th>
                <th className={headCellClass}>Updated</th>
                {canAct && status === "failed" ? (
                  <th className={headCellClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {syncs.data.syncs.map((sync) => (
                <SyncRow
                  key={sync.id}
                  companyId={companyId}
                  sync={sync}
                  canRetry={canAct && sync.status === "failed"}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
    <tr className="align-top">
      <td className={cellClass}>
        <p className="font-medium">{subjectLabel(sync)}</p>
        <p className="text-xs text-stone-500">
          {sync.subject?.date ?? ""} {sync.subjectId}
        </p>
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        {sync.subject ? formatKesCents(sync.subject.amountKesCents) : "—"}
      </td>
      <td className={cellClass}>{sync.attempts}</td>
      <td className={cellClass}>
        {sync.status === "synced" ? (
          <span>
            {sync.externalId}
            {sync.receiptAttached ? " · receipt attached" : " · no receipt"}
          </span>
        ) : (
          <span className="text-stone-700">{sync.lastError ?? "—"}</span>
        )}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        {formatNairobiTime(sync.updatedAt)}
      </td>
      {canRetry ? (
        <td className={cellClass}>
          <button
            type="button"
            className={secondaryButton}
            disabled={retry.isPending || retry.isSuccess}
            onClick={() => retry.mutate()}
          >
            {retry.isSuccess ? "Queued" : "Retry"}
          </button>
          {retry.isError ? (
            <p role="alert" className="mt-1 text-xs text-error-700">
              {describeApiError(retry.error)}
            </p>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
