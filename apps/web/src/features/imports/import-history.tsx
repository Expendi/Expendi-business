"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  importHistoryDetailSchema,
  importHistoryPageSchema,
} from "@expendi-business/shared";

import { secondaryButton } from "~/components/styles";
import { describeApiError } from "~/lib/api";
import { formatNairobiDate } from "~/lib/dates";
import { useApi } from "~/lib/use-api";
import { ImportResults } from "./import-results";

export function ImportHistory({ organizationId }: { organizationId: string }) {
  const api = useApi();
  const [selected, setSelected] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["imports", organizationId, "history"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get(
        `/organizations/${organizationId}/imports?offset=${pageParam}`,
        importHistoryPageSchema,
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const detail = useQuery({
    queryKey: ["imports", organizationId, selected],
    enabled: selected !== null,
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/imports/${selected ?? ""}`,
        importHistoryDetailSchema,
      ),
  });
  const entries = history.data?.pages.flatMap((page) => page.imports) ?? [];
  return (
    <section
      className="space-y-4 border-t border-stone-200 pt-6"
      aria-labelledby="import-history-title"
    >
      <h2 id="import-history-title" className="text-lg font-semibold">
        Import history
      </h2>
      {history.isPending ? <p role="status">Loading import history…</p> : null}
      {history.isError ? (
        <div role="alert">
          <p>{describeApiError(history.error)}</p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => void history.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {history.isSuccess && !entries.length ? (
        <p className="text-sm text-stone-600">
          Your completed imports will appear here, with who imported them and
          the results.
        </p>
      ) : null}
      <ul className="divide-y divide-stone-200">
        {entries.map((entry) => (
          <li key={entry.id} className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="break-all font-medium">{entry.fileName}</h3>
                <p className="text-sm text-stone-600">
                  {entry.kind === "history"
                    ? "Paid expenses"
                    : entry.kind === "bill"
                      ? "Unpaid bills"
                      : entry.kind}{" "}
                  · {entry.rowsImported} imported · {entry.rowsSkipped} skipped
                </p>
                <p className="text-sm text-stone-600">
                  {entry.importedBy} · {formatNairobiDate(entry.createdAt)}
                </p>
              </div>
              <button
                type="button"
                className={secondaryButton}
                aria-expanded={selected === entry.id}
                onClick={() =>
                  setSelected(selected === entry.id ? null : entry.id)
                }
              >
                {selected === entry.id ? "Hide results" : "View results"}
              </button>
            </div>
            {selected === entry.id ? (
              <div className="mt-4">
                {detail.isPending ? (
                  <p role="status">Loading results…</p>
                ) : detail.isError ? (
                  <p role="alert">{describeApiError(detail.error)}</p>
                ) : (
                  <ImportResults rows={detail.data.rows} completed />
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {history.hasNextPage ? (
        <button
          type="button"
          className={secondaryButton}
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading…" : "Load older imports"}
        </button>
      ) : null}
    </section>
  );
}
