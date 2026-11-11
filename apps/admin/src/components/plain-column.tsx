import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type {
  DataTableColumnDef,
  DataTableRow,
} from "~/components/data/data-table";
import type { DataTableColumnMeta } from "~/lib/data-table-features";
import { DataTableColumnHeader } from "~/components/data/data-table";

/**
 * A column of an API list that has no sort of its own: a plain header, text
 * from `value`, or `cell` when it renders more than text.
 */
export function plainColumn<TData extends RowData>({
  id,
  title,
  value,
  cell,
  meta,
}: {
  id: string;
  title: string;
  value: (row: TData) => string;
  cell?: (row: TData) => ReactNode;
  meta?: DataTableColumnMeta;
}): DataTableColumnDef<TData> {
  return {
    id,
    accessorFn: value,
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={title} />
    ),
    cell: ({ row }: { row: DataTableRow<TData> }) =>
      cell ? cell(row.original) : value(row.original),
    meta: { label: title, ...meta },
  };
}
