"use client";

import type { JSX } from "react";
import { TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { PayrollRun, Salary } from "@expendi-business/shared";

import type { SortState } from "~/components/data/data-table";
import type {
  RunSortKey,
  SalarySortKey,
} from "~/features/payroll/payroll-display";
import { EntityMark, Mini, PhoneCard } from "~/components/data/cells";
import {
  DataTable,
  DataTablePagination,
  sortFromTable,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import {
  RUN_STATUS_LABELS,
  runMeta,
  SALARY_STATE_LABELS,
  UNCONFIRMED_NUMBER,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { formatIsoDate } from "~/lib/dates";
import {
  RUN_SORT_KEYS,
  runColumns,
  RunMarks,
  SALARY_SORT_KEYS,
  salaryColumns,
} from "./columns";

function useStableOpen(onOpen: (id: string) => void): (id: string) => void {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  return useCallback((id: string) => latest.current(id), []);
}

/** Payroll runs, latest pay day first; each opens its sheet. */
export function RunsTable({
  rows,
  sort,
  onSort,
  openId,
  onOpen,
  today,
}: {
  rows: readonly PayrollRun[];
  sort: SortState<RunSortKey>;
  onSort: (sort: SortState<RunSortKey>) => void;
  openId: string | null;
  onOpen: (runId: string) => void;
  today: string;
}): JSX.Element {
  const open = useStableOpen(onOpen);
  const columns = useMemo(
    () => runColumns({ today, onOpen: open }),
    [today, open],
  );
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (run) => run.id,
    manual: { sorting: true },
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(sortFromTable(next, sort, RUN_SORT_KEYS)),
    },
  });
  return (
    <>
      <DataTable
        table={table}
        caption="Payroll runs, latest pay day first"
        phoneLabel="Payroll runs"
        onRowOpen={(run) => onOpen(run.id)}
        openRowId={openId}
        renderPhoneCard={(row) => {
          const run = row.original;
          const status = RUN_STATUS_LABELS[run.status];
          return (
            <PhoneCard
              key={row.id}
              mark={
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 flex-none items-center justify-center rounded-lg border border-border bg-card text-muted-foreground"
                >
                  <UsersIcon className="size-4" />
                </span>
              }
              title={formatIsoDate(run.payDate)}
              sub={progressInWords(run) ?? runMeta(run, today)}
              flags={
                <>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  <RunMarks run={run} />
                </>
              }
              aside={
                <AmountStack>
                  <Money amount={run.totalKes} currency="KES" />
                </AmountStack>
              }
              onOpen={() => onOpen(run.id)}
            />
          );
        }}
      />
      <DataTablePagination table={table} noun="runs" />
    </>
  );
}

/** Everyone on payroll, A to Z with ended salaries last. */
export function SalariesTable({
  rows,
  sort,
  onSort,
  openId,
  onOpen,
}: {
  rows: readonly Salary[];
  sort: SortState<SalarySortKey>;
  onSort: (sort: SortState<SalarySortKey>) => void;
  openId: string | null;
  onOpen: (salaryId: string) => void;
}): JSX.Element {
  const open = useStableOpen(onOpen);
  const columns = useMemo(() => salaryColumns({ onOpen: open }), [open]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (salary) => salary.id,
    manual: { sorting: true },
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(sortFromTable(next, sort, SALARY_SORT_KEYS)),
    },
  });
  return (
    <>
      <DataTable
        table={table}
        caption="Salaries, monthly net pay"
        phoneLabel="Salaries"
        onRowOpen={(salary) => onOpen(salary.id)}
        openRowId={openId}
        renderPhoneCard={(row) => {
          const salary = row.original;
          const state = SALARY_STATE_LABELS[salary.state];
          const unconfirmed =
            salary.payee.payoutPhoneConfirmed === false &&
            salary.state !== "ended";
          return (
            <PhoneCard
              key={row.id}
              mark={<EntityMark name={salary.payee.name} kind="person" />}
              title={salary.payee.name}
              sub={
                salary.nextPayDate
                  ? `Next pay date ${formatIsoDate(salary.nextPayDate)}`
                  : salary.endsOn
                    ? `Ended ${formatIsoDate(salary.endsOn)}`
                    : null
              }
              flags={
                <>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  {unconfirmed ? (
                    <Mini
                      icon={TriangleAlertIcon}
                      label={UNCONFIRMED_NUMBER}
                      warn
                    />
                  ) : null}
                </>
              }
              aside={
                <AmountStack>
                  <Money amount={salary.amountKes} currency="KES" />
                </AmountStack>
              }
              onOpen={() => onOpen(salary.id)}
            />
          );
        }}
      />
      <DataTablePagination table={table} noun="salaries" />
    </>
  );
}

const NO_ROWS: readonly PayrollRun[] = [];

export function PayrollTableSkeleton(): JSX.Element {
  const columns = useMemo(
    () => runColumns({ today: "", onOpen: () => undefined }),
    [],
  );
  const table = useDataTable({
    data: NO_ROWS,
    columns,
    getRowId: (run) => run.id,
    paginate: false,
  });
  return <DataTable table={table} caption="Loading payroll" loading />;
}
