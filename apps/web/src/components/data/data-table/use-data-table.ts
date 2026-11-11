"use client";

import type {
  ColumnFiltersState,
  ColumnVisibilityState,
  OnChangeFn,
  PaginationState,
  ReactTable,
  Row,
  RowData,
  RowSelectionState,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { functionalUpdate, useTable } from "@tanstack/react-table";
import { useState } from "react";

import type {
  DataTableColumnDef,
  DataTableFeatures,
} from "~/lib/data-table-features";
import { dataTableFeatures } from "~/lib/data-table-features";

export type DataTable<TData extends RowData> = ReactTable<
  DataTableFeatures,
  TData
>;
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;

/** A state slice the page may own; left out, the hook keeps it. */
interface Controlled<T> {
  value?: T;
  onChange?: (value: T) => void;
}

function useSlice<T>(
  initial: T,
  { value, onChange }: Controlled<T>,
): [T, OnChangeFn<T>] {
  const [own, setOwn] = useState(initial);
  const current = value ?? own;
  const set: OnChangeFn<T> = (updater: Updater<T>) => {
    const next = functionalUpdate(updater, current);
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  return [current, set];
}

export interface UseDataTableOptions<TData extends RowData> {
  data: readonly TData[];
  columns: DataTableColumnDef<TData>[];
  getRowId: (row: TData) => string;
  /**
   * The server already sorts, filters and pages `data` (most API lists):
   * the table only reports what was asked for through the `on…Change`
   * callbacks. `true` turns all three off; pick them one by one with the
   * object form.
   */
  manual?:
    boolean | { sorting?: boolean; filtering?: boolean; pagination?: boolean };
  /** The total behind a manually paginated `data`, for "1–20 of 134". */
  rowCount?: number;
  /** False shows every row on one page, e.g. a list the API already caps. */
  paginate?: boolean;
  sorting?: Controlled<SortingState> & { initial?: SortingState };
  pagination?: Controlled<PaginationState> & { initialPageSize?: number };
  /** The toolbar's search box. */
  globalFilter?: Controlled<string>;
  columnFilters?: Controlled<ColumnFiltersState>;
  columnVisibility?: Controlled<ColumnVisibilityState> & {
    initial?: ColumnVisibilityState;
  };
  rowSelection?: Controlled<RowSelectionState>;
  /** Which rows can be ticked; tables without a select column leave it out. */
  enableRowSelection?: boolean | ((row: DataTableRow<TData>) => boolean);
}

/**
 * A TanStack Table v9 instance on the shared feature registry, for
 * `<DataTable>` and its toolbar, pagination and view options. Each state
 * slice is the hook's own unless the page passes `value` and `onChange`.
 */
export function useDataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  manual = false,
  rowCount,
  paginate = true,
  sorting: sortingOptions = {},
  pagination: paginationOptions = {},
  globalFilter: globalFilterOptions = {},
  columnFilters: columnFilterOptions = {},
  columnVisibility: visibilityOptions = {},
  rowSelection: selectionOptions = {},
  enableRowSelection = false,
}: UseDataTableOptions<TData>): DataTable<TData> {
  const [sorting, setSorting] = useSlice(
    sortingOptions.initial ?? [],
    sortingOptions,
  );
  const [pagination, setPagination] = useSlice(
    { pageIndex: 0, pageSize: paginationOptions.initialPageSize ?? 20 },
    paginationOptions,
  );
  const [globalFilter, setGlobalFilter] = useSlice("", globalFilterOptions);
  const [columnFilters, setColumnFilters] = useSlice<ColumnFiltersState>(
    [],
    columnFilterOptions,
  );
  const [columnVisibility, setColumnVisibility] = useSlice(
    visibilityOptions.initial ?? {},
    visibilityOptions,
  );
  const [rowSelection, setRowSelection] = useSlice<RowSelectionState>(
    {},
    selectionOptions,
  );
  const manualAll = manual === true;
  const manualParts = typeof manual === "object" ? manual : {};

  return useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId,
    state: {
      sorting,
      pagination,
      globalFilter,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    onGlobalFilterChange: (updater: Updater<string>) => {
      setGlobalFilter(updater);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    },
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    enableRowSelection,
    globalFilterFn: "includesString",
    manualSorting: manualAll || manualParts.sorting,
    manualFiltering: manualAll || manualParts.filtering,
    manualPagination: !paginate || manualAll || manualParts.pagination,
    rowCount,
  });
}
