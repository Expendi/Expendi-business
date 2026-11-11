import type { ColumnDef, RowData } from "@tanstack/react-table";
import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnVisibilityFeature,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_arrIncludes,
  filterFn_equalsString,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table";

/** How a column lays out, read by `components/data/data-table`. */
export interface DataTableColumnMeta {
  /** The column's name in the view options when its header isn't a plain string. */
  label?: string;
  /** `end` for amounts. */
  align?: "start" | "end";
  /**
   * main: takes the spare width and truncates; date: muted, unwrapped and
   * tabular; checkbox: the narrow select column.
   */
  kind?: "plain" | "main" | "date" | "checkbox";
  /** Hide under a 900px (`md`) or 960px (`lg`) results panel, least important first. */
  collapse?: "md" | "lg";
  /** Extra classes for the column's header and cells. */
  className?: string;
}

const columnMeta: DataTableColumnMeta = {};

/**
 * The TanStack Table v9 features every dashboard table registers. V9 wants
 * features and built-in functions listed explicitly; sharing one registry
 * keeps `useDataTable`, column definitions and the kit's helpers on the same
 * type, and lets unused features tree-shake.
 */
export const dataTableFeatures = tableFeatures({
  columnFacetingFeature,
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: {
    arrIncludes: filterFn_arrIncludes,
    equalsString: filterFn_equalsString,
    includesString: filterFn_includesString,
  },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;

export type DataTableColumnDef<TData extends RowData> = ColumnDef<
  DataTableFeatures,
  TData
>;
