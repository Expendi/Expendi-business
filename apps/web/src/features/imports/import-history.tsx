"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  importHistoryDetailSchema,
  importHistoryPageSchema,
} from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { secondaryButton } from "~/components/styles";
import { describeApiError } from "~/lib/api";
import { useApi } from "~/lib/use-api";
import { historyColumns } from "./columns";
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
  const entries = useMemo(
    () => history.data?.pages.flatMap((page) => page.imports) ?? [],
    [history.data],
  );
  const columns = useMemo(
    () =>
      historyColumns({
        selected,
        onToggle: (id) =>
          setSelected((current) => (current === id ? null : id)),
      }),
    [selected],
  );
  const table = useDataTable({
    data: entries,
    columns,
    getRowId: (entry) => entry.id,
    paginate: false,
  });
  const selectedEntry = entries.find((entry) => entry.id === selected);
  return (
    <section
      className="space-y-4 border-t border-border pt-6"
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
        <p className="text-sm text-muted-foreground">
          Your completed imports will appear here, with who imported them and
          the results.
        </p>
      ) : null}
      {entries.length ? (
        <div className="overflow-clip rounded-xl border border-border bg-card">
          <DataTable table={table} caption="Import history" />
        </div>
      ) : null}
      {selectedEntry ? (
        <div>
          <h3 className="mb-2 font-medium break-all">
            {selectedEntry.fileName}
          </h3>
          {detail.isPending ? (
            <p role="status">Loading results…</p>
          ) : detail.isError ? (
            <p role="alert">{describeApiError(detail.error)}</p>
          ) : (
            <ImportResults rows={detail.data.rows} completed />
          )}
        </div>
      ) : null}
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
