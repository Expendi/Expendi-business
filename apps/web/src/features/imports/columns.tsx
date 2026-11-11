import type { z } from "zod";

import type {
  importHistoryEntrySchema,
  ImportReport,
} from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { RowMeta, RowTitle } from "~/components/data/cells";
import { secondaryButton } from "~/components/styles";
import { formatNairobiDate } from "~/lib/dates";

export type ImportRow = ImportReport["rows"][number];
export type ImportHistoryEntry = z.infer<typeof importHistoryEntrySchema>;

function resultLabel(row: ImportRow, completed: boolean): string {
  if (row.status === "ready") return completed ? "Imported" : "Ready";
  return row.status === "error" ? "Needs correction" : "Skipped";
}

export function resultColumns(
  completed: boolean,
): DataTableColumnDef<ImportRow>[] {
  return [
    {
      id: "row",
      accessorKey: "row",
      header: "Source row",
      enableSorting: false,
      meta: { label: "Source row" },
    },
    {
      id: "result",
      accessorFn: (row) => resultLabel(row, completed),
      header: "Result",
      enableSorting: false,
      meta: { label: "Result" },
    },
    {
      id: "details",
      accessorFn: (row) => Object.keys(row.values).join(),
      header: "Details",
      cell: ({ row }) =>
        Object.entries(row.original.values).map(([field, value]) => (
          <div key={field}>
            <span className="text-muted-foreground">{field}: </span>
            {value}
          </div>
        )),
      enableSorting: false,
      meta: {
        label: "Details",
        className: "min-w-48 whitespace-normal break-words",
      },
    },
    {
      id: "message",
      accessorFn: (row) => row.message,
      header: "Message",
      cell: ({ row }) => (
        <>
          {completed && row.original.status === "ready"
            ? "Imported successfully."
            : row.original.message}
          {row.original.newRecords?.map((record) => (
            <p key={`${record.kind}:${record.name}`} className="mt-1">
              {completed ? "Created" : "Create new"} {record.kind}:{" "}
              {record.name}
            </p>
          ))}
        </>
      ),
      enableSorting: false,
      meta: { label: "Message", className: "min-w-48 whitespace-normal" },
    },
  ];
}

function kindLabel(entry: ImportHistoryEntry): string {
  if (entry.kind === "history") return "Paid expenses";
  return entry.kind === "bill" ? "Unpaid bills" : entry.kind;
}

export function historyColumns({
  selected,
  onToggle,
}: {
  selected: string | null;
  onToggle: (id: string) => void;
}): DataTableColumnDef<ImportHistoryEntry>[] {
  return [
    {
      id: "import",
      accessorFn: (entry) => entry.fileName,
      header: "Import",
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <>
            <RowTitle>
              <span className="break-all">{entry.fileName}</span>
            </RowTitle>
            <RowMeta
              text={`${kindLabel(entry)} · ${String(entry.rowsImported)} imported · ${String(entry.rowsSkipped)} skipped`}
            />
            <RowMeta
              text={`${entry.importedBy} · ${formatNairobiDate(entry.createdAt)}`}
            />
          </>
        );
      },
      enableSorting: false,
      enableHiding: false,
      meta: { kind: "main", label: "Import" },
    },
    {
      id: "results",
      header: () => <span className="sr-only">Results</span>,
      cell: ({ row }) => (
        <button
          type="button"
          className={secondaryButton}
          aria-expanded={selected === row.original.id}
          onClick={() => onToggle(row.original.id)}
        >
          {selected === row.original.id ? "Hide results" : "View results"}
        </button>
      ),
      enableSorting: false,
      enableHiding: false,
      meta: { align: "end", label: "Results" },
    },
  ];
}
