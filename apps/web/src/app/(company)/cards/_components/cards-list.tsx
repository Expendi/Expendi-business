"use client";

import type { JSX } from "react";
import { useMemo } from "react";

import type { ExpendiCard } from "@expendi-business/shared";

import type { CardSortKey } from "./cards-display";
import type { SortState } from "~/components/data/data-table";
import { PhoneCard } from "~/components/data/cells";
import {
  DataTable,
  sortFromTable,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import { AmountStack } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import {
  CARD_STATE,
  formatUsd,
  holderName,
  maskedLastFour,
} from "./cards-display";
import { CARD_SORT_KEYS, cardColumns, HolderMark } from "./columns";
import { Usd } from "./usd";
import { useStableOpen } from "./use-stable-open";

/**
 * Every card the company has issued, already in `sort` order; a row opens
 * its side sheet.
 */
export function CardsTable({
  cards,
  sort,
  onSort,
  openId,
  onOpen,
}: {
  cards: readonly ExpendiCard[];
  sort: SortState<CardSortKey>;
  onSort: (sort: SortState<CardSortKey>) => void;
  openId: string | null;
  onOpen: (cardId: string) => void;
}): JSX.Element {
  const open = useStableOpen(onOpen);
  const columns = useMemo(() => cardColumns({ onOpen: open }), [open]);
  const table = useDataTable({
    data: cards,
    columns,
    getRowId: (card) => card.id,
    manual: true,
    paginate: false,
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(sortFromTable(next, sort, CARD_SORT_KEYS)),
    },
  });
  return (
    <DataTable
      table={table}
      caption="Expendi cards"
      onRowOpen={(card) => onOpen(card.id)}
      openRowId={openId}
      renderPhoneCard={(row) => {
        const card = row.original;
        const state = CARD_STATE[card.state];
        const holder = holderName(card.holder);
        return (
          <PhoneCard
            key={row.id}
            mark={<HolderMark holder={card.holder} />}
            title={card.nickname}
            sub={`${maskedLastFour(card.lastFour)} · ${holder}`}
            flags={<StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
            aside={
              <AmountStack
                sub={`of ${formatUsd(card.monthlyLimitUsdCents)} a month`}
              >
                <Usd cents={card.spentThisMonthUsdCents} />
              </AmountStack>
            }
            onOpen={() => onOpen(card.id)}
          />
        );
      }}
    />
  );
}

const NO_CARDS: readonly ExpendiCard[] = [];

export function CardsTableSkeleton(): JSX.Element {
  const columns = useMemo(() => cardColumns({ onOpen: () => undefined }), []);
  const table = useDataTable({
    data: NO_CARDS,
    columns,
    getRowId: (card) => card.id,
    paginate: false,
  });
  return (
    <DataTable table={table} caption="Loading cards" loading skeletonRows={5} />
  );
}
