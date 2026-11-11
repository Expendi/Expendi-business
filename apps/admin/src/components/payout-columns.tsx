import Link from "next/link";

import type { StaffPayoutSummary } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { PayoutStatusBadge } from "~/components/payout-status";
import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";

/** What a payout pays: a claim, bill, float or withdrawal, or pay in a payroll run. */
export function subjectLabel(payout: StaffPayoutSummary): string {
  return payout.payrollRunId ? "payroll run" : payout.subjectType;
}

function amountText(payout: StaffPayoutSummary): string {
  return payout.method === "usdc" && payout.amountToTransferUsdc
    ? formatUsdc(payout.amountToTransferUsdc)
    : formatKesCents(payout.amountKesCents);
}

export function payoutColumns(
  showCompany: boolean,
): DataTableColumnDef<StaffPayoutSummary>[] {
  const company: DataTableColumnDef<StaffPayoutSummary>[] = showCompany
    ? [
        {
          id: "company",
          accessorFn: (payout) => payout.organization.name,
          enableSorting: false,
          header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Company" />
          ),
          cell: ({ row }) => (
            <Link
              href={`/companies/${row.original.organization.id}`}
              className="wrap-anywhere underline-offset-4 hover:underline"
            >
              {row.original.organization.name}
            </Link>
          ),
          meta: {
            label: "Company",
            className: "min-w-40 max-w-64 whitespace-normal",
          },
        },
      ]
    : [];
  return [
    {
      id: "created",
      accessorFn: (payout) => formatNairobiTime(payout.createdAt),
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created" />
      ),
      cell: ({ row }) => (
        <Link
          href={`/payouts/${row.original.id}`}
          className="font-medium text-accent-foreground underline-offset-4 hover:underline"
        >
          {formatNairobiTime(row.original.createdAt)}
        </Link>
      ),
      meta: { label: "Created" },
    },
    ...company,
    {
      id: "for",
      accessorFn: (payout) => subjectLabel(payout),
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="For" />
      ),
      cell: ({ row }) => (
        <>
          {subjectLabel(row.original)}
          <span className="block text-xs text-muted-foreground">
            {row.original.method.replace("_", " ")} via {row.original.provider}
          </span>
        </>
      ),
      meta: { label: "For" },
    },
    {
      id: "amount",
      accessorFn: (payout) => amountText(payout),
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{amountText(row.original)}</span>
      ),
      meta: { label: "Amount" },
    },
    {
      id: "status",
      accessorFn: (payout) => payout.status,
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => <PayoutStatusBadge status={row.original.status} />,
      meta: { label: "Status" },
    },
    {
      id: "order",
      accessorFn: (payout) => payout.providerOrderId ?? "",
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title="Paycrest order / reason"
        />
      ),
      cell: ({ row }) => (
        <>
          {row.original.providerOrderId ? (
            <span className="block font-mono text-xs break-all">
              {row.original.providerOrderId}
            </span>
          ) : null}
          {row.original.failureReason ? (
            <span className="block text-xs text-muted-foreground">
              {row.original.failureReason}
            </span>
          ) : null}
        </>
      ),
      meta: {
        label: "Paycrest order / reason",
        className: "min-w-56 max-w-sm whitespace-normal",
      },
    },
  ];
}
