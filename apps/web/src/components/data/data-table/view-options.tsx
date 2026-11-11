"use client";

import type { Column, RowData } from "@tanstack/react-table";
import type { JSX } from "react";
import { Columns3Icon } from "lucide-react";

import type { DataTable } from "./use-data-table";
import type { DataTableFeatures } from "~/lib/data-table-features";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/** A column's name for people: `meta.label`, a string header, or its id. */
export function columnLabel<TData extends RowData>(
  column: Column<DataTableFeatures, TData, unknown>,
): string {
  const { header, meta } = column.columnDef;
  return meta?.label ?? (typeof header === "string" ? header : column.id);
}

/** The template's "Columns" menu: show or hide the columns that can hide. */
export function DataTableViewOptions<TData extends RowData>({
  table,
}: {
  table: DataTable<TData>;
}): JSX.Element {
  const columns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Columns3Icon aria-hidden="true" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(value)}
              onSelect={(event) => event.preventDefault()}
            >
              {columnLabel(column)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
