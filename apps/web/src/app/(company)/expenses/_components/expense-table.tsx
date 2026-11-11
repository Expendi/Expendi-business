"use client";

import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { Expense, ExpenseSortKey } from "@expendi-business/shared";

import type { SortState } from "~/components/data/data-table";
import { EntityMark, PhoneCard } from "~/components/data/cells";
import {
  DataTable,
  sortFromTable,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatIsoDate } from "~/lib/dates";
import { EXPENSE_SORT_KEYS, expenseColumns, Flags } from "./columns";
import { EXPENSE_STATUS, personName } from "./expense-labels";

function useStableOpen(onOpen: (id: string) => void): (id: string) => void {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  return useCallback((id: string) => latest.current(id), []);
}

/**
 * One flat list the API already sorts and filters, so the table runs in
 * manual mode; phone cards under a 720px panel.
 */
export function ExpenseTable({
  rows,
  openId,
  sort,
  onSort,
  onOpen,
}: {
  rows: readonly Expense[];
  openId: string | null;
  sort: SortState<ExpenseSortKey>;
  onSort: (sort: SortState<ExpenseSortKey>) => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  const open = useStableOpen(onOpen);
  const columns = useMemo(() => expenseColumns({ onOpen: open }), [open]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (expense) => expense.id,
    manual: true,
    paginate: false,
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(sortFromTable(next, sort, EXPENSE_SORT_KEYS)),
    },
  });
  return (
    <DataTable
      table={table}
      caption="Expenses"
      onRowOpen={(expense) => onOpen(expense.id)}
      openRowId={openId}
      renderPhoneCard={(row) => {
        const expense = row.original;
        const status = EXPENSE_STATUS[expense.status];
        const person = personName(expense.member);
        return (
          <PhoneCard
            key={row.id}
            mark={<EntityMark name={person} kind="person" />}
            title={expense.merchant}
            sub={`${person} · ${formatIsoDate(expense.spentOn)}`}
            flags={
              <>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <Flags expense={expense} etims="always" />
              </>
            }
            aside={
              <AmountStack>
                <Money amount={expense.amountKes} currency="KES" />
              </AmountStack>
            }
            onOpen={() => onOpen(expense.id)}
          />
        );
      }}
    />
  );
}

const NO_ROWS: readonly Expense[] = [];

export function ExpenseTableSkeleton(): JSX.Element {
  const columns = useMemo(
    () => expenseColumns({ onOpen: () => undefined }),
    [],
  );
  const table = useDataTable({
    data: NO_ROWS,
    columns,
    getRowId: (expense) => expense.id,
    paginate: false,
  });
  return <DataTable table={table} caption="Loading expenses" loading />;
}
