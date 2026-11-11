"use client";

import type { RowData } from "@tanstack/react-table";
import type { JSX } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";
import { useId } from "react";

import type { DataTable } from "./use-data-table";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

/** "21–40 of 134"; "0 of 0" when empty. */
export function rangeText({
  pageIndex,
  pageSize,
  total,
}: {
  pageIndex: number;
  pageSize: number;
  total: number;
}): string {
  if (total === 0) return "0 of 0";
  const first = pageIndex * pageSize + 1;
  const last = Math.min(total, first + pageSize - 1);
  return `${first.toLocaleString("en-KE")}–${last.toLocaleString("en-KE")} of ${total.toLocaleString("en-KE")}`;
}

/**
 * The template's footer: selected count, rows per page, the range shown and
 * first / previous / next / last. With manual pagination it reads the
 * table's `rowCount`.
 */
export function DataTablePagination<TData extends RowData>({
  table,
  pageSizes = [10, 20, 50, 100],
  noun = "rows",
}: {
  table: DataTable<TData>;
  pageSizes?: readonly number[];
  /** What the rows are, e.g. "bills", in "2 of 40 bills selected". */
  noun?: string;
}): JSX.Element {
  const sizeId = useId();
  const { pageIndex, pageSize } = table.state.pagination;
  const total = table.getRowCount();
  const selected = Object.keys(table.state.rowSelection).length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {selected > 0
          ? `${selected.toLocaleString("en-KE")} of ${total.toLocaleString("en-KE")} ${noun} selected`
          : rangeText({ pageIndex, pageSize, total })}
      </p>
      <div className="flex items-center gap-4 sm:gap-6">
        <div className="hidden items-center gap-2 lg:flex">
          <label htmlFor={sizeId} className="text-sm font-medium">
            Rows per page
          </label>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <SelectTrigger id={sizeId} size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              <SelectGroup>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm font-medium whitespace-nowrap">
          Page {(pageIndex + 1).toLocaleString("en-KE")} of{" "}
          {Math.max(1, table.getPageCount()).toLocaleString("en-KE")}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden size-8 lg:inline-flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
          >
            <ChevronsLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="size-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="size-8"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden size-8 lg:inline-flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            <ChevronsRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
