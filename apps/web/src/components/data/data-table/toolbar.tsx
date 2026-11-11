"use client";

import type { RowData } from "@tanstack/react-table";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";

import type { DataTable } from "./use-data-table";
import { Input } from "~/components/ui/input";
import { DataTableViewOptions } from "./view-options";

function searchValue(filter: unknown): string {
  return typeof filter === "string" ? filter : "";
}

/**
 * The row above a table: the search box (the table's global filter, so a
 * manual table hears it through `globalFilter.onChange`), then whatever the
 * page adds (`KindTabs`, `FilterChip`s), then the Columns menu and actions.
 */
export function DataTableToolbar<TData extends RowData>({
  table,
  searchLabel,
  searchPlaceholder = searchLabel,
  viewOptions = true,
  children,
  actions,
  className,
}: {
  table: DataTable<TData>;
  /** e.g. "Search bills"; leave it out for no search box. */
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Show the Columns menu. */
  viewOptions?: boolean;
  /** Filters beside the search box. */
  children?: ReactNode;
  /** Buttons at the end. */
  actions?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-4 py-3",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {searchLabel ? (
          <div className="relative w-full sm:w-72">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              value={searchValue(table.state.globalFilter)}
              onChange={(event) => table.setGlobalFilter(event.target.value)}
              className="h-8 pl-8"
            />
          </div>
        ) : null}
        {children}
      </div>
      {viewOptions || actions ? (
        <div className="flex items-center gap-2">
          {viewOptions ? (
            <div className="max-[900px]:hidden">
              <DataTableViewOptions table={table} />
            </div>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
