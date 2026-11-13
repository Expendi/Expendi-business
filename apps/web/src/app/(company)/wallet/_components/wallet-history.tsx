"use client";

import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";

import type { WalletHistoryItem } from "@expendi-business/shared";

import type { HistoryFilter } from "./wallet-display";
import type { DataTableColumnDef } from "~/components/data/data-table";
import { DataTable, useDataTable } from "~/components/data/data-table";
import { EmptyState, ErrorState } from "~/components/data/states";
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { describeApiError } from "~/lib/api";
import { historyColumns, TxPhoneCard } from "./columns";
import { TxSheet } from "./tx-sheet";
import { useWalletHistory } from "./wallet-api";
import { dayHeading, filterHistory, groupByDay } from "./wallet-display";

const FILTERS: readonly { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in", label: "Money in" },
  { value: "out", label: "Money out" },
];

const EMPTY: Record<HistoryFilter, { title: string; text: string }> = {
  all: {
    title: "No movements yet",
    text: "Deposits show up here once they arrive.",
  },
  in: { title: "No money in", text: "No money in for these dates." },
  out: { title: "No money out", text: "No money out for these dates." },
};

/** Every deposit, payment, refund and withdrawal, newest first (spec §6.9). */
export function WalletHistory({
  organizationId,
  today,
  rate,
}: {
  organizationId: string;
  today: string;
  rate: string | null;
}): JSX.Element {
  const history = useWalletHistory(organizationId);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [openId, setOpenId] = useDeepLinkParam("txId");
  const items = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data],
  );
  const visible = useMemo(() => filterHistory(items, filter), [items, filter]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const open = items.find((item) => item.id === openId) ?? null;
  const index = open ? visible.findIndex((item) => item.id === open.id) : -1;
  const openItem = useCallback(
    (item: WalletHistoryItem) => setOpenId(item.id),
    [setOpenId],
  );
  const columns = useMemo(
    () => historyColumns(openItem, today),
    [openItem, today],
  );

  return (
    <Card
      role="region"
      aria-labelledby="history-title"
      className="gap-0 overflow-hidden py-0 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-[18px] pb-3.5 max-[600px]:px-4">
        <h2
          id="history-title"
          className="text-lg leading-[26px] font-(--w-title) text-foreground"
        >
          History
        </h2>
        <fieldset className="m-0 inline-flex gap-0.5 rounded-lg border-0 bg-muted p-[3px]">
          <legend className="sr-only">Show</legend>
          {FILTERS.map((option) => (
            <label
              key={option.value}
              className="relative inline-flex h-[30px] cursor-pointer items-center rounded-md px-3 text-sm font-(--w-ui) text-muted-foreground transition-colors duration-150 has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring dark:has-checked:bg-input/30"
            >
              <input
                type="radio"
                name="history-filter"
                value={option.value}
                checked={filter === option.value}
                onChange={() => setFilter(option.value)}
                className="absolute inset-0 m-0 cursor-pointer opacity-0"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
      {history.isPending ? (
        <HistoryLoading columns={columns} />
      ) : history.isError ? (
        <ErrorState
          title="The history didn't load"
          onRetry={() => void history.refetch()}
        >
          {describeApiError(history.error)}
        </ErrorState>
      ) : visible.length === 0 ? (
        <div className="border-t border-border">
          <EmptyState title={EMPTY[filter].title}>
            {EMPTY[filter].text}
          </EmptyState>
        </div>
      ) : (
        days.map((group, at) => (
          <DayGroup
            key={group.day}
            heading={dayHeading(group.day, today)}
            today={today}
            items={group.items}
            columns={columns}
            openId={openId}
            onOpen={openItem}
            showHead={at === 0}
          />
        ))
      )}
      {history.hasNextPage ? (
        <div className="border-t border-border px-5 pt-3 pb-4 max-[600px]:px-4">
          <Button
            variant="outline"
            size="md"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      <TxSheet
        item={open}
        items={items}
        today={today}
        rate={rate}
        onClose={() => setOpenId(null)}
        stepper={{
          index,
          total: visible.length,
          onStep: (delta) => {
            const next = visible[index + delta];
            if (next) setOpenId(next.id);
          },
          previousLabel: "Previous movement",
          nextLabel: "Next movement",
        }}
      />
    </Card>
  );
}

/**
 * One Nairobi day's movements under its heading. Each day is its own table
 * on the shared kit; only the first shows its column headings.
 */
function DayGroup({
  heading,
  today,
  items,
  columns,
  openId,
  onOpen,
  showHead,
}: {
  heading: string;
  today: string;
  items: readonly WalletHistoryItem[];
  columns: DataTableColumnDef<WalletHistoryItem>[];
  openId: string | null;
  onOpen: (item: WalletHistoryItem) => void;
  showHead: boolean;
}): JSX.Element {
  const table = useDataTable({
    data: items,
    columns,
    getRowId: (item) => item.id,
    paginate: false,
  });
  return (
    <section aria-label={heading}>
      <h3 className="border-y border-border bg-muted/40 px-5 py-2 text-xs leading-4 font-(--w-ui) text-muted-foreground max-[600px]:px-4">
        {heading}
      </h3>
      <DataTable
        table={table}
        caption={heading}
        onRowOpen={onOpen}
        openRowId={openId}
        className={showHead ? undefined : "[&_thead]:sr-only"}
        renderPhoneCard={(row) => (
          <TxPhoneCard
            key={row.id}
            item={row.original}
            today={today}
            onOpen={() => onOpen(row.original)}
          />
        )}
      />
    </section>
  );
}

function HistoryLoading({
  columns,
}: {
  columns: DataTableColumnDef<WalletHistoryItem>[];
}): JSX.Element {
  const table = useDataTable({
    data: [],
    columns,
    getRowId: (item) => item.id,
    paginate: false,
  });
  return (
    <div className="border-t border-border">
      <DataTable
        table={table}
        caption="Loading history"
        loading
        skeletonRows={4}
      />
    </div>
  );
}
