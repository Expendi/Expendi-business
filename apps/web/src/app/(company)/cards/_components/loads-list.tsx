"use client";

import type { JSX } from "react";

import type { CardLoad } from "@expendi-business/shared";

import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  PhoneCards,
  RowMeta,
  RowTitle,
  TableSkeletonRows,
  Td,
  Th,
} from "~/components/data/table";
import { formatNairobiDate } from "~/lib/dates";
import { formatKes } from "~/lib/money";
import { Usd } from "./usd";

const rateLine = (load: CardLoad) =>
  `At KES ${load.usdKesRate} per USD · KES ${formatKes(load.amountKes)}`;

/** Every Card load, newest first. Loads are a record: nothing to open. */
export function LoadsTable({
  loads,
}: {
  loads: readonly CardLoad[];
}): JSX.Element {
  return (
    <>
      <DataTable caption="Card loads">
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Loaded by</Th>
            <Th align="end">Amount</Th>
            <Th>Kind</Th>
          </tr>
        </thead>
        <tbody>
          {loads.map((load) => (
            <DataRow key={load.id}>
              <Td kind="date">{formatNairobiDate(load.createdAt)}</Td>
              <Td kind="main">
                <RowTitle>{load.loadedBy}</RowTitle>
                <RowMeta text={rateLine(load)} />
              </Td>
              <Td align="end">
                <AmountStack
                  sub={<Money amount={load.amountKes} currency="KES" />}
                >
                  <Usd cents={load.amountUsdCents} />
                </AmountStack>
              </Td>
              <Td>
                {load.simulated ? (
                  <StatusBadge tone="quiet">Simulated</StatusBadge>
                ) : null}
              </Td>
            </DataRow>
          ))}
        </tbody>
      </DataTable>
      <PhoneCards label="Card loads">
        {loads.map((load) => (
          <li
            key={load.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-row-divider px-4 py-3.5"
          >
            <span className="min-w-0">
              <span className="block truncate text-base leading-6 font-(--w-name) text-gray-900">
                {load.loadedBy}
              </span>
              <span className="block truncate text-gray-500 tabular-nums">
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
        ))}
      </PhoneCards>
    </>
  );
}

export function LoadsTableSkeleton(): JSX.Element {
  return (
    <DataTable caption="Loading Card loads">
      <tbody>
        <TableSkeletonRows rows={4} columns={4} />
      </tbody>
    </DataTable>
  );
}
