import type { DiffKind } from "~/lib/json-diff";
import { diffJson } from "~/lib/json-diff";

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
    <div className="overflow-x-auto rounded-md border border-stone-200">
      <table className="w-full text-left font-mono text-xs">
        <thead className="bg-stone-100 font-sans text-stone-600">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Field
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Before
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              After
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Change</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.path}
              className={`border-t border-stone-200 align-top ${ROW_STYLES[row.kind]}`}
            >
              <td className="px-3 py-2 text-stone-700">{row.path}</td>
              <td className="px-3 py-2 break-all">{row.before ?? "—"}</td>
              <td className="px-3 py-2 break-all">{row.after ?? "—"}</td>
              <td className="px-3 py-2 font-sans text-stone-500">
                {KIND_LABELS[row.kind]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
