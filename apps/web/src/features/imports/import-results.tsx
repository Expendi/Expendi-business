import type { ImportReport } from "@expendi-business/shared";

import { cellClass, headCellClass, tableClass } from "~/components/styles";

export function ImportResults({
  rows,
  completed = false,
}: {
  rows: ImportReport["rows"];
  completed?: boolean;
}) {
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-stone-200">
      <table className={tableClass}>
        <caption className="sr-only">
          {completed
            ? "Completed import results"
            : "Import preview by source row"}
        </caption>
        <thead>
          <tr>
            {["Source row", "Result", "Details", "Message"].map((label) => (
              <th key={label} scope="col" className={headCellClass}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row} className="border-t border-stone-200">
              <td className={cellClass}>{row.row}</td>
              <td className={cellClass}>
                {row.status === "ready"
                  ? completed
                    ? "Imported"
                    : "Ready"
                  : row.status === "error"
                    ? "Needs correction"
                    : "Skipped"}
              </td>
              <td className={`${cellClass} min-w-48 break-words`}>
                {Object.entries(row.values).map(([field, value]) => (
                  <div key={field}>
                    <span className="text-stone-500">{field}: </span>
                    {value}
                  </div>
                ))}
              </td>
              <td className={`${cellClass} min-w-48`}>
                {completed && row.status === "ready"
                  ? "Imported successfully."
                  : row.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
