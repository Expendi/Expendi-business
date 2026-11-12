import type { JSX } from "react";

import type { Customer, InvoiceSummary } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { EntityMark, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { StatusBadge } from "~/components/data/status-badge";
import { InvoiceStatusBadges, Usd } from "~/features/invoices/invoice-status";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";

const STATUS_ORDER = ["draft", "open", "paid", "void"] as const;

export function invoiceColumns({
  onOpen,
}: {
  onOpen: (invoiceId: string) => void;
}): DataTableColumnDef<InvoiceSummary>[] {
  return [
    {
      id: "invoice",
      accessorFn: (invoice) => `${invoice.number} ${invoice.customerName}`,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Invoice" />
      ),
      cell: ({ row }) => (
        <span className="min-w-0">
          <RowTitle onOpen={() => onOpen(row.original.id)}>
            {row.original.number}
          </RowTitle>
          <RowMeta text={row.original.customerName} />
        </span>
      ),
      enableHiding: false,
      meta: { kind: "main", label: "Invoice" },
    },
    {
      id: "status",
      accessorFn: (invoice) =>
        `${String(STATUS_ORDER.indexOf(invoice.status))}${invoice.overdue ? "1" : "0"}`,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <InvoiceStatusBadges
          status={row.original.status}
          overdue={row.original.overdue}
        />
      ),
      meta: { label: "Status" },
    },
    {
      id: "due",
      accessorFn: (invoice) => invoice.dueOn,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Due" />
      ),
      cell: ({ row }) => formatIsoDate(row.original.dueOn),
      meta: { kind: "date", label: "Due", collapse: "md" },
    },
    {
      id: "sent",
      accessorFn: (invoice) => invoice.sentAt ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Sent" />
      ),
      cell: ({ row }) =>
        row.original.sentAt
          ? formatNairobiDate(row.original.sentAt)
          : "Not sent",
      meta: { kind: "date", label: "Sent", collapse: "lg" },
    },
    {
      id: "total",
      accessorFn: (invoice) => Number(invoice.totalCents),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Total" />
      ),
      cell: ({ row }) => (
        <span className="text-base leading-6 font-(--w-amount)">
          <Usd cents={row.original.totalCents} />
        </span>
      ),
      meta: { align: "end", label: "Total" },
    },
  ];
}

export function customerColumns({
  onOpen,
}: {
  onOpen: (customerId: string) => void;
}): DataTableColumnDef<Customer>[] {
  return [
    {
      id: "name",
      accessorFn: (customer) => `${customer.name} ${customer.email}`,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Customer" />
      ),
      cell: ({ row }): JSX.Element => (
        <span className="flex min-w-0 items-start gap-3">
          <EntityMark name={row.original.name} />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original.id)}>
              {row.original.name}
            </RowTitle>
            <RowMeta text={row.original.email} />
          </span>
        </span>
      ),
      enableHiding: false,
      meta: { kind: "main", label: "Customer" },
    },
    {
      id: "taxId",
      accessorFn: (customer) => customer.taxId ?? "",
      header: "Tax ID",
      cell: ({ row }) => row.original.taxId ?? "None",
      enableSorting: false,
      meta: {
        label: "Tax ID",
        collapse: "md",
        className: "whitespace-nowrap text-muted-foreground",
      },
    },
    {
      id: "archived",
      accessorFn: (customer) => (customer.archived ? "Archived" : "Active"),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) =>
        row.original.archived ? (
          <StatusBadge tone="rejected">Archived</StatusBadge>
        ) : (
          <StatusBadge tone="paid">Active</StatusBadge>
        ),
      meta: { label: "Status", collapse: "lg" },
    },
  ];
}
