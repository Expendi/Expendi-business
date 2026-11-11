"use client";

import type { JSX } from "react";
import {
  CheckIcon,
  FileWarningIcon,
  ImageOffIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { Expense, ExpenseSortKey } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { EntityMark, Mini, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatIsoDate } from "~/lib/dates";
import { FIRST_DIRECTION } from "./expense-filters";
import {
  EXPENSE_STATUS,
  KIND_LABELS,
  personName,
  WARNING_LABELS,
  warningCodes,
} from "./expense-labels";

export const EXPENSE_SORT_KEYS: readonly ExpenseSortKey[] = [
  "date",
  "person",
  "merchant",
  "amount",
  "status",
];

/**
 * A row's markers: warnings, a missing receipt, and no eTIMS invoice
 * where the eTIMS column isn't showing (`collapsed`: only under a 900px
 * panel, where the column hides).
 */
export function Flags({
  expense,
  etims,
}: {
  expense: Expense;
  etims: "always" | "collapsed";
}): JSX.Element {
  return (
    <>
      {warningCodes(expense.warnings).map((code) => (
        <Mini
          key={code}
          icon={TriangleAlertIcon}
          label={WARNING_LABELS[code]}
          warn
        >
          {WARNING_LABELS[code]}
        </Mini>
      ))}
      {expense.noReceipt ? (
        <Mini icon={ImageOffIcon} label="No receipt">
          No receipt
        </Mini>
      ) : null}
      {expense.etimsStatus === "none" ? (
        <span
          className={
            etims === "collapsed"
              ? "hidden @max-[900px]/results:inline-flex"
              : "inline-flex"
          }
        >
          <Mini icon={FileWarningIcon} label="No eTIMS invoice">
            No eTIMS
          </Mini>
        </span>
      ) : null}
    </>
  );
}

function EtimsCell({ expense }: { expense: Expense }): JSX.Element {
  if (expense.etimsStatus === "attached") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-secondary-foreground">
        <CheckIcon aria-hidden="true" className="size-3.5 text-success-700" />
        Attached
      </span>
    );
  }
  if (expense.etimsStatus === "none") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-warn-700">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
        None
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap text-muted-foreground">
      Not required
    </span>
  );
}

function sortable(
  id: ExpenseSortKey,
  title: string,
): Pick<DataTableColumnDef<Expense>, "header" | "sortDescFirst"> {
  return {
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={title} />
    ),
    sortDescFirst: FIRST_DIRECTION[id] === "desc",
  };
}

export function expenseColumns({
  onOpen,
}: {
  onOpen: (id: string) => void;
}): DataTableColumnDef<Expense>[] {
  return [
    {
      id: "date",
      accessorFn: (expense) => expense.spentOn,
      ...sortable("date", "Date"),
      cell: ({ row }) => formatIsoDate(row.original.spentOn),
      meta: { kind: "date", label: "Date" },
    },
    {
      id: "person",
      accessorFn: (expense) => personName(expense.member),
      ...sortable("person", "Person"),
      cell: ({ row }) => {
        const person = personName(row.original.member);
        return (
          <span className="flex items-center gap-2.5 whitespace-nowrap">
            <EntityMark name={person} kind="person" />
            {person}
          </span>
        );
      },
      meta: { label: "Person" },
    },
    {
      id: "merchant",
      accessorFn: (expense) => expense.merchant,
      ...sortable("merchant", "Expense"),
      cell: ({ row }) => (
        <>
          <RowTitle onOpen={() => onOpen(row.original.id)}>
            {row.original.merchant}
          </RowTitle>
          <RowMeta
            text={`${KIND_LABELS[row.original.listKind]} · ${row.original.category.name}`}
          >
            <Flags expense={row.original} etims="collapsed" />
          </RowMeta>
        </>
      ),
      meta: { kind: "main", label: "Expense" },
    },
    {
      id: "amount",
      accessorFn: (expense) => expense.amountKes,
      ...sortable("amount", "Amount"),
      cell: ({ row }) => (
        <AmountStack>
          <Money amount={row.original.amountKes} currency="KES" />
        </AmountStack>
      ),
      meta: { align: "end", label: "Amount" },
    },
    {
      id: "etims",
      enableSorting: false,
      header: "eTIMS",
      cell: ({ row }) => <EtimsCell expense={row.original} />,
      meta: { collapse: "md", label: "eTIMS" },
    },
    {
      id: "status",
      accessorFn: (expense) => expense.status,
      ...sortable("status", "Status"),
      cell: ({ row }) => {
        const status = EXPENSE_STATUS[row.original.status];
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
      meta: { label: "Status" },
    },
  ];
}
