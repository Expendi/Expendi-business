import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  AccountingSync,
  AccountingSyncStatus,
  ExpenseKind,
} from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";
import { Button } from "~/components/ui/button";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

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

function RetryCell({
  companyId,
  sync,
}: {
  companyId: string;
  sync: AccountingSync;
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
    <>
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
    </>
  );
}

export function syncColumns({
  companyId,
  status,
  canAct,
}: {
  companyId: string;
  status: AccountingSyncStatus;
  canAct: boolean;
}): DataTableColumnDef<AccountingSync>[] {
  const actions: DataTableColumnDef<AccountingSync>[] =
    canAct && status === "failed"
      ? [
          {
            id: "actions",
            enableSorting: false,
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }) =>
              row.original.status === "failed" ? (
                <RetryCell companyId={companyId} sync={row.original} />
              ) : null,
            meta: { label: "Actions" },
          },
        ]
      : [];
  return [
    plainColumn<AccountingSync>({
      id: "item",
      title: "Item",
      value: (sync) => subjectLabel(sync),
      cell: (sync) => (
        <>
          <p className="font-medium">{subjectLabel(sync)}</p>
          <p className="text-xs text-muted-foreground">
            {sync.subject?.date ?? ""} {sync.subjectId}
          </p>
        </>
      ),
      meta: { kind: "main", className: "min-w-48 max-w-72 whitespace-normal" },
    }),
    plainColumn<AccountingSync>({
      id: "amount",
      title: "Amount",
      value: (sync) =>
        sync.subject ? formatKesCents(sync.subject.amountKesCents) : "—",
      cell: (sync) => (
        <span className="tabular-nums">
          {sync.subject ? formatKesCents(sync.subject.amountKesCents) : "—"}
        </span>
      ),
    }),
    plainColumn<AccountingSync>({
      id: "tries",
      title: "Tries",
      value: (sync) => String(sync.attempts),
    }),
    plainColumn<AccountingSync>({
      id: "detail",
      title: status === "synced" ? "Zoho expense" : "Last error",
      value: (sync) =>
        sync.status === "synced"
          ? (sync.externalId ?? "")
          : (sync.lastError ?? "—"),
      cell: (sync) =>
        sync.status === "synced" ? (
          <span>
            {sync.externalId}
            {sync.receiptAttached ? " · receipt attached" : " · no receipt"}
          </span>
        ) : (
          <span className="text-foreground">{sync.lastError ?? "—"}</span>
        ),
      meta: { className: "min-w-48 max-w-80 whitespace-normal" },
    }),
    plainColumn<AccountingSync>({
      id: "updated",
      title: "Updated",
      value: (sync) => formatNairobiTime(sync.updatedAt),
    }),
    ...actions,
  ];
}
