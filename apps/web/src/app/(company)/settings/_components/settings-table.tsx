"use client";

import type { RowData } from "@tanstack/react-table";
import type { JSX } from "react";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { DataTable, useDataTable } from "~/components/data/data-table";

/**
 * A settings panel's list on the data kit. The column headers stay for
 * screen readers; the panel's own title says what the list is.
 */
export function SettingsTable<TData extends RowData>({
  caption,
  data,
  columns,
  getRowId,
  openId = null,
  onOpen,
}: {
  caption: string;
  data: readonly TData[];
  columns: DataTableColumnDef<TData>[];
  getRowId: (row: TData) => string;
  openId?: string | null;
  onOpen?: (row: TData) => void;
}): JSX.Element {
  const table = useDataTable({
    data,
    columns,
    getRowId,
    manual: true,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption={caption}
      onRowOpen={onOpen}
      openRowId={openId}
      className="border-t border-border [&_thead]:sr-only"
    />
  );
}
