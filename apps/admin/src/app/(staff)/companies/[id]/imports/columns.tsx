import type { ImportReport } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";

export type ImportRow = ImportReport["rows"][number];

export const importRowColumns: DataTableColumnDef<ImportRow>[] = [
  plainColumn<ImportRow>({
    id: "row",
    title: "Row",
    value: (row) => String(row.row),
  }),
  plainColumn<ImportRow>({
    id: "status",
    title: "Status",
    value: (row) => row.status,
  }),
  plainColumn<ImportRow>({
    id: "values",
    title: "Mapped values",
    value: (row) =>
      Object.entries(row.values)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" "),
    cell: (row) =>
      Object.entries(row.values).map(([key, value]) => (
        <div key={key}>
          <span className="text-muted-foreground">{key}: </span>
          {value}
        </div>
      )),
    meta: { kind: "main", className: "min-w-56 max-w-sm whitespace-normal" },
  }),
  plainColumn<ImportRow>({
    id: "result",
    title: "Result",
    value: (row) => row.message,
  }),
];
