"use client";

import type { JSX } from "react";
import { useMemo } from "react";

import type { CardLoad } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatNairobiDate } from "~/lib/dates";
import { loadColumns } from "./columns";
import { Usd } from "./usd";

/** Every Card load, newest first. Loads are a record: nothing to open. */
export function LoadsTable({
  loads,
}: {
  loads: readonly CardLoad[];
}): JSX.Element {
  const columns = useMemo(() => loadColumns(), []);
  const table = useDataTable({
    data: loads,
    columns,
    getRowId: (load) => load.id,
    manual: true,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption="Card loads"
      renderPhoneCard={(row) => {
        const load = row.original;
        return (
          <li
            key={row.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border px-4 py-3.5"
          >
            <span className="min-w-0">
              <span className="block truncate text-base leading-6 font-(--w-name) text-foreground">
                {load.loadedBy}
              </span>
              <span className="block truncate text-muted-foreground tabular-nums">
                {formatNairobiDate(load.createdAt)}
              </span>
              {load.simulated ? (
                <span className="mt-1.5 flex flex-wrap items-center gap-1">
                  <StatusBadge tone="quiet">Simulated</StatusBadge>
                </span>
              ) : null}
            </span>
            <AmountStack sub={<Money amount={load.amountKes} currency="KES" />}>
              <Usd cents={load.amountUsdCents} />
            </AmountStack>
          </li>
        );
      }}
    />
  );
}

const NO_LOADS: readonly CardLoad[] = [];

export function LoadsTableSkeleton(): JSX.Element {
  const columns = useMemo(() => loadColumns(), []);
  const table = useDataTable({
    data: NO_LOADS,
    columns,
    getRowId: (load) => load.id,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption="Loading Card loads"
      loading
      skeletonRows={4}
    />
  );
}
