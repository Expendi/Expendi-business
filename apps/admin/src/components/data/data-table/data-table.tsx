"use client";

import type { Column, RowData } from "@tanstack/react-table";
import type { JSX, MouseEvent, ReactNode } from "react";
import { cn } from "cn";

import type { DataTableRow, DataTable as Table } from "./use-data-table";
import type {
  DataTableColumnMeta,
  DataTableFeatures,
} from "~/lib/data-table-features";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  Table as TableRoot,
  TableRow,
} from "~/components/ui/table";
import { isInsideControl } from "../cells";
import { Skel } from "../states";

const COLLAPSE: Record<NonNullable<DataTableColumnMeta["collapse"]>, string> = {
  md: "@max-[900px]/results:hidden",
  lg: "@max-[960px]/results:hidden",
};

function metaOf<TData extends RowData>(
  column: Column<DataTableFeatures, TData, unknown>,
): DataTableColumnMeta {
  return column.columnDef.meta ?? {};
}

function columnClass(meta: DataTableColumnMeta): string {
  return cn(
    meta.align === "end" && "text-right",
    meta.collapse && COLLAPSE[meta.collapse],
    meta.kind === "checkbox" && "w-12 pr-0",
    meta.className,
  );
}

function cellClass(meta: DataTableColumnMeta): string {
  return cn(
    columnClass(meta),
    meta.kind === "main" && "w-full max-w-0 whitespace-normal",
    meta.kind === "date" && "text-muted-foreground tabular-nums",
  );
}

function ariaSort<TData extends RowData>(
  column: Column<DataTableFeatures, TData, unknown>,
): "ascending" | "descending" | "none" | undefined {
  if (!column.getCanSort()) return undefined;
  const sorted = column.getIsSorted();
  if (sorted === "asc") return "ascending";
  if (sorted === "desc") return "descending";
  return "none";
}

/**
 * The template's data table on TanStack Table v9 (`useDataTable`): header
 * groups with `aria-sort`, flex-rendered cells, loading and empty rows, and
 * rows that open their side sheet. Give it `renderPhoneCard` and, under a
 * 720px wide table (or a 900px window), it shows those cards instead.
 * Frame it with `ResultsPanel` or a `Card`.
 */
export function DataTable<TData extends RowData>({
  table,
  caption,
  onRowOpen,
  openRowId,
  loading = false,
  skeletonRows = 6,
  empty = "Nothing to show.",
  renderPhoneCard,
  phoneLabel,
  className,
}: {
  table: Table<TData>;
  /** Read out to screen readers; the visible title lives outside. */
  caption: string;
  /** Opens a row's details; clicks on its own buttons, links and checkboxes stay theirs. */
  onRowOpen?: (row: TData) => void;
  /** The row whose sheet is showing, marked with a bar. */
  openRowId?: string | null;
  /** First load: skeleton rows in place of data. */
  loading?: boolean;
  skeletonRows?: number;
  /** Shown in a single row when there are no rows. */
  empty?: ReactNode;
  /** The same row as a `PhoneCard`, for narrow panels and phones. */
  renderPhoneCard?: (row: DataTableRow<TData>) => ReactNode;
  /** The phone list's accessible name; defaults to the caption. */
  phoneLabel?: string;
  className?: string;
}): JSX.Element {
  const rows = table.getRowModel().rows;
  const columns = table.getVisibleLeafColumns();

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, row: TData) {
    if (onRowOpen && !isInsideControl(event.target)) onRowOpen(row);
  }

  return (
    <div className={cn("@container/results min-w-0", className)}>
      <div
        className={cn(
          renderPhoneCard && "max-[900px]:hidden @max-[720px]/results:hidden",
        )}
      >
        <TableRoot aria-label={caption}>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={ariaSort(header.column)}
                    className={columnClass(metaOf(header.column))}
                  >
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody aria-busy={loading || undefined}>
            {loading ? (
              Array.from({ length: skeletonRows }, (_, index) => (
                <TableRow
                  key={index}
                  aria-hidden="true"
                  className="hover:bg-transparent"
                >
                  {columns.map((column) => (
                    <TableCell key={column.id}>
                      <Skel
                        width={metaOf(column).kind === "main" ? "60%" : 72}
                        height={14}
                        className={cn(
                          metaOf(column).align === "end" && "ml-auto",
                        )}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center whitespace-normal text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const open = openRowId === row.id;
                return (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    data-open={open || undefined}
                    onClick={(event) => onRowClick(event, row.original)}
                    className={cn(
                      onRowOpen && "cursor-pointer",
                      open &&
                        "bg-muted shadow-[inset_3px_0_0_var(--foreground)]",
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cellClass(metaOf(cell.column))}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </TableRoot>
      </div>
      {renderPhoneCard ? (
        <ul
          aria-label={phoneLabel ?? caption}
          className="m-0 hidden list-none p-0 max-[900px]:block @max-[720px]/results:block"
        >
          {loading ? (
            Array.from({ length: 3 }, (_, index) => (
              <li
                key={index}
                aria-hidden="true"
                className="grid gap-2 border-b border-border px-4 py-3.5"
              >
                <Skel width="55%" height={14} />
                <Skel width="35%" height={12} />
              </li>
            ))
          ) : rows.length === 0 ? (
            <li className="px-4 py-8 text-center text-muted-foreground">
              {empty}
            </li>
          ) : (
            rows.map((row) => renderPhoneCard(row))
          )}
        </ul>
      ) : null}
    </div>
  );
}
