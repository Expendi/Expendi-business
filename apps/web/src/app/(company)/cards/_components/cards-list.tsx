"use client";

import type { JSX } from "react";

import type { ExpendiCard } from "@expendi-business/shared";

import type { CardSortKey } from "./cards-display";
import type { SortState } from "~/components/data/table";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import { AmountStack } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  EntityMark,
  nextSort,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  TableSkeletonRows,
  Td,
  Th,
} from "~/components/data/table";
import {
  CARD_SORT_FIRST,
  CARD_STATE,
  formatUsd,
  maskedLastFour,
} from "./cards-display";
import { Usd } from "./usd";

/** Every card the company has issued; a row opens its side sheet. */
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
  const sortBy = (key: CardSortKey) =>
    onSort(nextSort(sort, key, CARD_SORT_FIRST[key]));
  return (
    <>
      <DataTable caption="Expendi cards">
        <thead>
          <tr>
            <SortHeader
              label="Card"
              sortKey="card"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Holder"
              sortKey="holder"
              sort={sort}
              onSort={sortBy}
            />
            <Th>State</Th>
            <SortHeader
              label="Spent this month"
              sortKey="spent"
              sort={sort}
              onSort={sortBy}
              align="end"
            />
            <SortHeader
              label="Monthly limit"
              sortKey="limit"
              sort={sort}
              onSort={sortBy}
              align="end"
            />
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const state = CARD_STATE[card.state];
            const holder = personName(card.holder);
            return (
              <DataRow
                key={card.id}
                open={card.id === openId}
                onOpen={() => onOpen(card.id)}
              >
                <Td kind="main">
                  <RowTitle onOpen={() => onOpen(card.id)}>
                    {card.nickname}
                  </RowTitle>
                  <RowMeta
                    text={`${maskedLastFour(card.lastFour)} · ${card.defaultCategory.name}`}
                  />
                </Td>
                <Td>
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <EntityMark name={holder} kind="person" />
                    {holder}
                  </span>
                </Td>
                <Td>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                </Td>
                <Td align="end">
                  <AmountStack>
                    <Usd cents={card.spentThisMonthUsdCents} />
                  </AmountStack>
                </Td>
                <Td align="end">
                  <AmountStack>
                    <Usd cents={card.monthlyLimitUsdCents} />
                  </AmountStack>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Expendi cards">
        {cards.map((card) => {
          const state = CARD_STATE[card.state];
          const holder = personName(card.holder);
          return (
            <PhoneCard
              key={card.id}
              mark={<EntityMark name={holder} kind="person" />}
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
        })}
      </PhoneCards>
    </>
  );
}

export function CardsTableSkeleton(): JSX.Element {
  return (
    <DataTable caption="Loading cards">
      <tbody>
        <TableSkeletonRows rows={5} columns={5} />
      </tbody>
    </DataTable>
  );
}
