"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import { ArrowDownLeftIcon, LandmarkIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import type { WalletHistoryItem } from "@expendi-business/shared";

import type { HistoryFilter, TxKind } from "./wallet-display";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { EntityMark } from "~/components/data/table";
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";
import { panelClass, SignedUsdc } from "./balance-card";
import { TxSheet } from "./tx-sheet";
import { useWalletHistory } from "./wallet-api";
import {
  dayHeading,
  filterHistory,
  groupByDay,
  nairobiTime,
  rowBadge,
  txDetail,
  txKind,
  txTitle,
} from "./wallet-display";

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
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const visible = filterHistory(items, filter);
  const open = items.find((item) => item.id === openId) ?? null;
  const index = open ? visible.findIndex((item) => item.id === open.id) : -1;

  return (
    <section
      aria-labelledby="history-title"
      className={`${panelClass} overflow-hidden`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-[18px] pb-3.5 max-[600px]:px-4">
        <h2
          id="history-title"
          className="text-lg leading-[26px] font-(--w-title) text-gray-900"
        >
          History
        </h2>
        <fieldset className="m-0 inline-flex gap-0.5 rounded-control border-0 bg-gray-100 p-[3px]">
          <legend className="sr-only">Show</legend>
          {FILTERS.map((option) => (
            <label
              key={option.value}
              className="relative inline-flex h-[30px] cursor-pointer items-center rounded-[6px] px-3 text-sm font-(--w-ui) text-gray-600 transition-colors duration-150 has-checked:bg-surface has-checked:text-gray-900 has-checked:shadow-[0_1px_2px_rgb(16_24_40/0.1)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-700"
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
        <HistorySkeleton />
      ) : history.isError ? (
        <ErrorState
          title="The history didn't load"
          onRetry={() => void history.refetch()}
        >
          {describeApiError(history.error)}
        </ErrorState>
      ) : visible.length === 0 ? (
        <div className="border-t border-hairline">
          <EmptyState title={EMPTY[filter].title}>
            {EMPTY[filter].text}
          </EmptyState>
        </div>
      ) : (
        groupByDay(visible).map((group) => (
          <section key={group.day} aria-label={dayHeading(group.day, today)}>
            <h3 className="border-y border-hairline bg-gray-25 px-5 py-2 text-xs leading-4 font-(--w-ui) text-gray-500 max-[600px]:px-4">
              {dayHeading(group.day, today)}
            </h3>
            <ul className="m-0 list-none p-0">
              {group.items.map((item) => (
                <li
                  key={item.id}
                  className="border-t border-hairline first:border-t-0"
                >
                  <TxRow
                    item={item}
                    open={item.id === openId}
                    onOpen={() => setOpenId(item.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {history.hasNextPage ? (
        <div className="border-t border-hairline px-5 pt-3 pb-4 max-[600px]:px-4">
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
    </section>
  );
}

const TILES: Partial<Record<TxKind, LucideIcon>> = {
  deposit: ArrowDownLeftIcon,
  topup: ArrowDownLeftIcon,
  withdrawal: LandmarkIcon,
  refund: Undo2Icon,
};

/** A tile for the wallet's own movements; initials for whoever was paid. */
export function TxMark({ item }: { item: WalletHistoryItem }): JSX.Element {
  const kind = txKind(item);
  const Tile = TILES[kind];
  if (Tile) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-8 flex-none items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-600"
      >
        <Tile className="size-4" />
      </span>
    );
  }
  const subject = item.payout?.subjectType;
  const person =
    kind === "salary" || subject === "claim" || subject === "float";
  return (
    <EntityMark
      name={item.payout?.recipientName ?? txTitle(item)}
      kind={person ? "person" : "business"}
    />
  );
}

function TxRow({
  item,
  open,
  onOpen,
}: {
  item: WalletHistoryItem;
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  const badge = rowBadge(item);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      data-open={open || undefined}
      className="grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3.5 border-0 bg-transparent px-5 py-3 text-left transition-colors duration-150 hover:bg-gray-25 data-open:bg-gray-50 data-open:shadow-[inset_3px_0_0_var(--color-gray-900)] max-[600px]:gap-3 max-[600px]:px-4"
    >
      <TxMark item={item} />
      <span className="min-w-0">
        <span className="block truncate text-base leading-6 font-(--w-name) text-gray-900">
          {txTitle(item)}
        </span>
        <span className="block truncate text-sm leading-5 text-gray-500">
          {txDetail(item)}
        </span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <span className="text-base leading-6 font-(--w-amount)">
          <SignedUsdc amount={item.usdcAmount} />
        </span>
        <span className="flex items-center gap-1.5 text-xs leading-4 text-gray-500">
          {badge ? (
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          ) : null}
          <span className="tabular-nums">{nairobiTime(item.createdAt)}</span>
        </span>
      </span>
    </button>
  );
}

function HistorySkeleton(): JSX.Element {
  return (
    <div aria-busy="true" className="border-t border-hairline">
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-hairline px-5 py-3 first:border-t-0"
        >
          <Skel width={32} height={32} />
          <div>
            <Skel width="45%" height={14} />
            <Skel width="65%" height={12} style={{ marginTop: 8 }} />
          </div>
          <Skel width={90} height={14} />
        </div>
      ))}
    </div>
  );
}
