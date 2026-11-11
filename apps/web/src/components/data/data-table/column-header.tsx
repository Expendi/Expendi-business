"use client";

import type { Column, RowData } from "@tanstack/react-table";
import type { JSX } from "react";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import type { DataTableFeatures } from "~/lib/data-table-features";

/**
 * A sortable column's header: the title and an arrow for the current
 * direction. `<DataTable>` puts `aria-sort` on the cell. Columns that can't
 * sort get the plain title.
 */
export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
  className,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
  className?: string;
}): JSX.Element {
  if (!column.getCanSort()) {
    return <span className={className}>{title}</span>;
  }
  const sorted = column.getIsSorted();
  const Icon =
    sorted === "asc"
      ? ArrowUpIcon
      : sorted === "desc"
        ? ArrowDownIcon
        : ArrowUpDownIcon;
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        "group/sort -mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 [font:inherit] transition-colors hover:text-foreground",
        sorted && "text-foreground",
        column.columnDef.meta?.align === "end" && "flex-row-reverse",
        className,
      )}
    >
      {title}
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          sorted
            ? "text-foreground"
            : "text-muted-foreground/60 group-hover/sort:text-muted-foreground",
        )}
      />
    </button>
  );
}
