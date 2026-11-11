import { useMemo } from "react";

import type { ImportReport } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { resultColumns } from "./columns";

export function ImportResults({
  rows,
  completed = false,
}: {
  rows: ImportReport["rows"];
  completed?: boolean;
}) {
  const columns = useMemo(() => resultColumns(completed), [completed]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => String(row.row),
    paginate: false,
  });
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border">
      <DataTable
        table={table}
        caption={
          completed
            ? "Completed import results"
            : "Import preview by source row"
        }
      />
    </div>
  );
}
