import Link from "next/link";

import type { CompanySummary } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { Badge } from "~/components/ui/badge";
import { formatNairobiTime } from "~/lib/format";

export const companyColumns: DataTableColumnDef<CompanySummary>[] = [
  {
    id: "company",
    accessorFn: (company) => company.name,
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Company" />
    ),
    cell: ({ row }) => (
      <Link
        href={`/companies/${row.original.id}`}
        className="font-(--w-name) wrap-anywhere text-accent-foreground underline-offset-4 hover:underline"
      >
        {row.original.name}
      </Link>
    ),
    meta: { kind: "main", label: "Company" },
  },
  {
    id: "kraPin",
    accessorFn: (company) => company.kraPin ?? "—",
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="KRA PIN" />
    ),
    cell: ({ row }) => row.original.kraPin ?? "—",
    meta: { label: "KRA PIN" },
  },
  {
    id: "payouts",
    accessorFn: (company) => (company.payoutsPaused ? "Paused" : "Running"),
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Payouts" />
    ),
    cell: ({ row }) => (
      <Badge variant={row.original.payoutsPaused ? "secondary" : "outline"}>
        {row.original.payoutsPaused ? "Paused" : "Running"}
      </Badge>
    ),
    meta: { label: "Payouts" },
  },
  {
    id: "signedUp",
    accessorFn: (company) => formatNairobiTime(company.createdAt),
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Signed up" />
    ),
    cell: ({ row }) => formatNairobiTime(row.original.createdAt),
    meta: { kind: "date", label: "Signed up" },
  },
];
