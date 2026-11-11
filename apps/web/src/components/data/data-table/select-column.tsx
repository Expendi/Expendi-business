"use client";

import type { RowData } from "@tanstack/react-table";

import type { DataTableColumnDef } from "~/lib/data-table-features";
import { Checkbox } from "~/components/ui/checkbox";

/**
 * The tick-box column: "select all on this page" in the header and one per
 * row. Rows that `enableRowSelection` rules out get no box.
 */
export function selectColumn<TData extends RowData>({
  allLabel,
  rowLabel,
}: {
  /** e.g. "Select every bill on this page". */
  allLabel: string;
  /** e.g. (bill) => `Select ${bill.payee}`. */
  rowLabel: (row: TData) => string;
}): DataTableColumnDef<TData> {
  return {
    id: "select",
    enableSorting: false,
    enableHiding: false,
    meta: { kind: "checkbox" },
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() ? "indeterminate" : false)
        }
        onCheckedChange={(value) =>
          table.toggleAllPageRowsSelected(value === true)
        }
        aria-label={allLabel}
      />
    ),
    cell: ({ row }) =>
      row.getCanSelect() ? (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
          aria-label={rowLabel(row.original)}
        />
      ) : null,
  };
}
