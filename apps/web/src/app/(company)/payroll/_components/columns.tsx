"use client";

import type { JSX } from "react";
import { PencilIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import type { PayrollRun, Salary } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import type {
  RunSortKey,
  SalarySortKey,
} from "~/features/payroll/payroll-display";
import { EntityMark, Mini, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { KIND_LABELS, METHOD_LABELS } from "~/features/payees/payee-display";
import {
  payDayInWords,
  RUN_SORT_FIRST,
  RUN_STATUS_LABELS,
  runMeta,
  SALARY_SORT_FIRST,
  SALARY_STATE_LABELS,
  UNCONFIRMED_NUMBER,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { formatIsoDate } from "~/lib/dates";

/** How the draft changed: "2 changed for this run" and one-offs. */
export function RunMarks({ run }: { run: PayrollRun }): JSX.Element | null {
  if (run.adjusted === 0 && run.oneOffs === 0) return null;
  return (
    <>
      {run.adjusted > 0 ? (
        <Mini
          icon={PencilIcon}
          label={`${String(run.adjusted)} changed for this run`}
        >
          {run.adjusted}
        </Mini>
      ) : null}
      {run.oneOffs > 0 ? (
        <Mini
          icon={PlusIcon}
          label={`${String(run.oneOffs)} one-off ${run.oneOffs === 1 ? "payment" : "payments"}`}
        >
          {run.oneOffs}
        </Mini>
      ) : null}
    </>
  );
}

export const RUN_SORT_KEYS: readonly RunSortKey[] = [
  "payDate",
  "total",
  "status",
];

export const SALARY_SORT_KEYS: readonly SalarySortKey[] = [
  "person",
  "next",
  "amount",
  "status",
];

export function runColumns({
  today,
  onOpen,
}: {
  today: string;
  onOpen: (runId: string) => void;
}): DataTableColumnDef<PayrollRun>[] {
  return [
    {
      id: "payDate",
      accessorFn: (run) => run.payDate,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Pay day" />
      ),
      cell: ({ row }) => (
        <>
          <RowTitle onOpen={() => onOpen(row.original.id)}>
            <span className="tabular-nums">
              {formatIsoDate(row.original.payDate)}
            </span>
          </RowTitle>
          <RowMeta text={runMeta(row.original, today)}>
            <RunMarks run={row.original} />
          </RowMeta>
        </>
      ),
      sortDescFirst: RUN_SORT_FIRST.payDate === "desc",
      meta: { kind: "main", label: "Pay day" },
    },
    {
      id: "payments",
      enableSorting: false,
      header: "Payments",
      cell: ({ row }) => {
        const progress = progressInWords(row.original);
        return progress ? (
          <span className="tabular-nums">{progress}</span>
        ) : (
          "Not approved yet"
        );
      },
      meta: {
        collapse: "md",
        label: "Payments",
        className: "whitespace-nowrap text-muted-foreground",
      },
    },
    {
      id: "total",
      accessorFn: (run) => run.totalKes,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Total" />
      ),
      cell: ({ row }) => (
        <AmountStack>
          <Money amount={row.original.totalKes} currency="KES" />
        </AmountStack>
      ),
      sortDescFirst: RUN_SORT_FIRST.total === "desc",
      meta: { align: "end", label: "Total" },
    },
    {
      id: "status",
      accessorFn: (run) => run.status,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const status = RUN_STATUS_LABELS[row.original.status];
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
      sortDescFirst: RUN_SORT_FIRST.status === "desc",
      meta: { label: "Status" },
    },
  ];
}

function SalaryMeta({ salary }: { salary: Salary }): JSX.Element {
  if (salary.payee.payoutPhoneConfirmed === false && salary.state !== "ended") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-warn-700">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5 flex-none" />
        <span className="min-w-0 truncate">{UNCONFIRMED_NUMBER}</span>
      </span>
    );
  }
  return (
    <RowMeta
      text={`${KIND_LABELS[salary.payee.kind]} · ${salary.category.name}`}
    />
  );
}

export function salaryColumns({
  onOpen,
}: {
  onOpen: (salaryId: string) => void;
}): DataTableColumnDef<Salary>[] {
  return [
    {
      id: "person",
      accessorFn: (salary) => salary.payee.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Person" />
      ),
      cell: ({ row }) => (
        <span className="flex min-w-0 items-start gap-3">
          <EntityMark name={row.original.payee.name} kind="person" />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original.id)}>
              {row.original.payee.name}
            </RowTitle>
            <SalaryMeta salary={row.original} />
          </span>
        </span>
      ),
      sortDescFirst: SALARY_SORT_FIRST.person === "desc",
      meta: { kind: "main", label: "Person" },
    },
    {
      id: "paidBy",
      enableSorting: false,
      accessorFn: (salary) => salary.payee.method,
      header: "Paid by",
      cell: ({ row }) =>
        row.original.payee.method
          ? METHOD_LABELS[row.original.payee.method]
          : "Not set",
      meta: {
        collapse: "lg",
        label: "Paid by",
        className: "whitespace-nowrap text-muted-foreground",
      },
    },
    {
      id: "next",
      accessorFn: (salary) => salary.nextPayDate,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Next pay date" />
      ),
      cell: ({ row }) => (
        <>
          {row.original.nextPayDate
            ? formatIsoDate(row.original.nextPayDate)
            : ""}
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
            {row.original.state === "ended" && row.original.endsOn
              ? `Ended ${formatIsoDate(row.original.endsOn)}`
              : payDayInWords(row.original.payDay)}
          </span>
        </>
      ),
      sortDescFirst: SALARY_SORT_FIRST.next === "desc",
      meta: { kind: "date", label: "Next pay date" },
    },
    {
      id: "amount",
      accessorFn: (salary) => salary.amountKes,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Net pay" />
      ),
      cell: ({ row }) => (
        <AmountStack>
          <Money amount={row.original.amountKes} currency="KES" />
        </AmountStack>
      ),
      sortDescFirst: SALARY_SORT_FIRST.amount === "desc",
      meta: { align: "end", label: "Net pay" },
    },
    {
      id: "status",
      accessorFn: (salary) => salary.state,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const state = SALARY_STATE_LABELS[row.original.state];
        return <StatusBadge tone={state.tone}>{state.label}</StatusBadge>;
      },
      sortDescFirst: SALARY_SORT_FIRST.status === "desc",
      meta: { label: "Status" },
    },
  ];
}
