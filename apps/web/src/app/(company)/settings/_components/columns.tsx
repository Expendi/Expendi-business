import type { LucideIcon } from "lucide-react";
import {
  ArchiveRestoreIcon,
  BanknoteIcon,
  CreditCardIcon,
  LandmarkIcon,
  SmartphoneIcon,
  WalletIcon,
} from "lucide-react";

import type {
  AccountingSyncSubjectType,
  Category,
  CompanyZohoResponse,
  PaidFromAccount,
  PaidFromAccountKind,
} from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { RowButton, Tag } from "./settings-panel";

export const NO_INVOICE_EXPECTED = "No invoice expected";

export const ACCOUNT_KIND_LABELS: Record<PaidFromAccountKind, string> = {
  bank: "Bank account",
  card: "Card",
  mobile_money: "Mobile money",
  cash: "Cash",
  other: "Other",
};

const KIND_ICONS: Record<PaidFromAccountKind, LucideIcon> = {
  bank: LandmarkIcon,
  card: CreditCardIcon,
  mobile_money: SmartphoneIcon,
  cash: BanknoteIcon,
  other: WalletIcon,
};

export const SUBJECT_LABELS: Record<AccountingSyncSubjectType, string> = {
  expense: "Expense",
  bill: "Bill",
  payroll_run: "Payroll run",
};

export function categoryColumns({
  editable,
  canAct,
  restoringId,
  restoreDisabled,
  onEdit,
  onRestore,
}: {
  editable: boolean;
  canAct: boolean;
  restoringId: string | null;
  restoreDisabled: boolean;
  onEdit: (categoryId: string) => void;
  onRestore: (categoryId: string) => void;
}): DataTableColumnDef<Category>[] {
  return [
    {
      id: "name",
      accessorFn: (category) => category.name,
      enableSorting: false,
      header: () => <span>Category</span>,
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-(--w-name)">
            {row.original.name}
          </span>
          {row.original.etimsNotRequired ? (
            <Tag>{NO_INVOICE_EXPECTED}</Tag>
          ) : null}
        </span>
      ),
      meta: { kind: "main", label: "Category" },
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const category = row.original;
        if (editable) {
          return (
            <RowButton
              label={`Edit ${category.name}`}
              aria-haspopup="dialog"
              onClick={() => onEdit(category.id)}
            >
              Edit
            </RowButton>
          );
        }
        return canAct ? (
          <RowButton
            icon={ArchiveRestoreIcon}
            label={`Restore ${category.name}`}
            disabled={restoreDisabled}
            onClick={() => onRestore(category.id)}
          >
            {restoringId === category.id ? "Restoring…" : "Restore"}
          </RowButton>
        ) : null;
      },
      meta: { align: "end", label: "Actions" },
    },
  ];
}

export function accountColumns({
  editable,
  onEdit,
}: {
  editable: boolean;
  onEdit: (accountId: string) => void;
}): DataTableColumnDef<PaidFromAccount>[] {
  return [
    {
      id: "name",
      accessorFn: (account) => account.name,
      enableSorting: false,
      header: () => <span>Account</span>,
      cell: ({ row }) => {
        const account = row.original;
        const Icon = KIND_ICONS[account.kind];
        return (
          <span className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex size-8 flex-none items-center justify-center rounded-control border border-border bg-card text-muted-foreground"
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-(--w-name)">
                {account.name}
              </span>
              <span className="block truncate text-xs leading-4 text-muted-foreground">
                {ACCOUNT_KIND_LABELS[account.kind]}
              </span>
            </span>
          </span>
        );
      },
      meta: { kind: "main", label: "Account" },
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) =>
        editable ? (
          <RowButton
            label={`Edit ${row.original.name}`}
            aria-haspopup="dialog"
            onClick={() => onEdit(row.original.id)}
          >
            Edit
          </RowButton>
        ) : null,
      meta: { align: "end", label: "Actions" },
    },
  ];
}

type FailedItem = CompanyZohoResponse["failed"][number];

export const failedColumns: DataTableColumnDef<FailedItem>[] = [
  {
    id: "item",
    accessorFn: (item) => item.label ?? "",
    enableSorting: false,
    header: () => <span>Item</span>,
    cell: ({ row }) => {
      const item = row.original;
      return (
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-(--w-name)">
              {item.label ??
                `A ${SUBJECT_LABELS[item.subjectType].toLowerCase()}`}
            </span>
            <Tag>{SUBJECT_LABELS[item.subjectType]}</Tag>
          </span>
          <span className="mt-0.5 block text-muted-foreground">
            {item.reason ?? "Zoho Books didn't say why."}
          </span>
        </span>
      );
    },
    meta: { kind: "main", label: "Item" },
  },
  {
    id: "failedAt",
    accessorFn: (item) => item.failedAt,
    enableSorting: false,
    header: () => <span>Failed</span>,
    cell: ({ row }) => (
      <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
        {formatNairobiDateTime(row.original.failedAt)}
      </span>
    ),
    meta: { align: "end", label: "Failed" },
  },
];
