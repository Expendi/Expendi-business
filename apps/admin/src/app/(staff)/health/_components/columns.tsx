import type { SystemHealth } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";
import { formatNairobiTime } from "~/lib/format";

export type StationJob = SystemHealth["jobs"][number];

/** Measured against the database's clock, which the API reports, not the browser's. */
export function minutesAgo(iso: string, checkedAt: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(checkedAt) - Date.parse(iso)) / 60_000),
  );
  if (minutes === 0) return "less than a minute ago";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

export function jobColumns(
  checkedAt: string,
): DataTableColumnDef<StationJob>[] {
  return [
    plainColumn<StationJob>({
      id: "job",
      title: "Job",
      value: (job) => job.job,
      cell: (job) => <span className="font-mono text-xs">{job.job}</span>,
      meta: { kind: "main" },
    }),
    plainColumn<StationJob>({
      id: "lastFinished",
      title: "Last finished run",
      value: (job) => job.lastFinishedAt,
      cell: (job) => (
        <>
          {formatNairobiTime(job.lastFinishedAt)}{" "}
          <span className="text-muted-foreground">
            ({minutesAgo(job.lastFinishedAt, checkedAt)})
          </span>
        </>
      ),
    }),
  ];
}
