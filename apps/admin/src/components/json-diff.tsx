import type { DiffKind } from "~/lib/json-diff";
import { diffJson } from "~/lib/json-diff";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

const ROW_STYLES: Record<DiffKind, string> = {
  added: "bg-emerald-50",
  removed: "bg-error-50",
  changed: "bg-amber-50",
  unchanged: "",
};

const KIND_LABELS: Record<DiffKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "",
};

export function JsonDiff({
  before,
  after,
}: {
  before: unknown;
  after: unknown;
}) {
  const rows = diffJson(before, after);

  if (rows.length === 0) {
    return <p className="text-sm text-stone-500">No values recorded.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table
        aria-label="Before and after changes"
        className="font-mono text-xs"
      >
        <TableHeader className="font-sans">
          <TableRow>
            <TableHead scope="col">Field</TableHead>
            <TableHead scope="col">Before</TableHead>
            <TableHead scope="col">After</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Change</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.path} className={ROW_STYLES[row.kind]}>
              <TableCell className="min-w-32 max-w-64 break-all whitespace-normal">
                {row.path}
              </TableCell>
              <TableCell className="min-w-32 max-w-80 break-all whitespace-normal">
                {row.before ?? "—"}
              </TableCell>
              <TableCell className="min-w-32 max-w-80 break-all whitespace-normal">
                {row.after ?? "—"}
              </TableCell>
              <TableCell className="font-sans text-muted-foreground">
                {KIND_LABELS[row.kind]}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
