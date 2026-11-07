"use client";

import type { JSX } from "react";

import type { LargestPayment } from "@expendi-business/shared";

import type {
  CategoryRow,
  ChangeContext,
  SpendingMonthView,
} from "./reports-display";
import {
  DetailItem,
  DetailList,
  DetailSheet,
  SectionLabel,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { dayLabel, monthAbbr, monthLabel, monthName } from "./report-month";
import {
  changeLine,
  HEADING_KEYS,
  headingLabel,
  largestFor,
  paymentWho,
} from "./reports-display";
import { ColumnChart } from "./viz/column-chart";

const kesText = (value: number) => `KES ${value.toLocaleString("en-KE")}`;

/** A category's months, its headings and its largest payments in the chosen month. */
export function CategorySheet({
  row,
  months,
  context,
  largestPayments,
  index,
  total,
  onStep,
  onClose,
}: {
  row: CategoryRow | null;
  months: readonly SpendingMonthView[];
  context: ChangeContext;
  largestPayments: readonly LargestPayment[];
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}): JSX.Element {
  const { month, thisMonth } = context;
  const soFar = month === thisMonth;
  const selected = months.findIndex((entry) => entry.month === month);
  const largest = row ? largestFor(largestPayments, row.id) : [];
  const headings = row
    ? HEADING_KEYS.filter((key) => BigInt(row.headingsKes[key]) > 0n).sort(
        (a, b) => {
          const difference =
            BigInt(row.headingsKes[b]) - BigInt(row.headingsKes[a]);
          return difference > 0n ? 1 : difference < 0n ? -1 : 0;
        },
      )
    : [];
  return (
    <DetailSheet
      open={row !== null}
      onClose={onClose}
      eyebrow={`Category · ${monthLabel(month)}${soFar ? " so far" : ""}`}
      title={row?.name ?? "Category"}
      headerExtra={
        row ? (
          <>
            <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
              <Money amount={row.currentKes} currency="KES" />
            </p>
            <p className="mt-0.5 text-gray-600">
              {changeLine(row.current, row.previous, context)}
            </p>
          </>
        ) : null
      }
      stepper={{
        index,
        total,
        onStep,
        previousLabel: "Previous category",
        nextLabel: "Next category",
      }}
      stepKey={row?.id}
      footer={<SheetPosition index={index} total={total} />}
    >
      {row ? (
        <>
          <div className="flex flex-col gap-2">
            <SectionLabel>Last {months.length} months</SectionLabel>
            <ColumnChart
              labels={months.map((entry) => monthAbbr(entry.month))}
              values={row.trend}
              selected={selected}
              height={180}
              axis
              ariaLabel={`${row.name} by month. ${monthLabel(month)}: ${kesText(row.current)}. Use the arrow keys to read each month.`}
              tip={(at) => {
                const entry = months[at];
                return {
                  head: entry
                    ? `${monthLabel(entry.month)}${entry.month === thisMonth ? " (so far)" : ""}`
                    : "",
                  rows: [
                    {
                      key: entry?.month === month ? "selected" : "context",
                      value: kesText(row.trend[at] ?? 0),
                      label: row.name,
                    },
                  ],
                };
              }}
            />
          </div>
          {row.payments > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel>By heading in {monthName(month)}</SectionLabel>
              <DetailList>
                {headings.map((key) => (
                  <DetailItem key={key} label={headingLabel(key)}>
                    <Money amount={row.headingsKes[key]} currency="KES" />
                  </DetailItem>
                ))}
              </DetailList>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <SectionLabel>Largest payments in {monthName(month)}</SectionLabel>
            {largest.length > 0 ? (
              <ul className="m-0 list-none p-0">
                {largest.map((payment) => (
                  <li
                    key={payment.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-hairline py-2.5 first:border-t-0 first:pt-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-(--w-name) text-gray-900">
                        {payment.name}
                      </span>
                      <span className="block text-xs leading-4 text-gray-500 tabular-nums">
                        {dayLabel(payment.date)} · {paymentWho(payment)}
                      </span>
                    </span>
                    <Money amount={payment.amountKes} currency="KES" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs leading-4 text-gray-500">
                Nothing in {monthName(month)}.
              </p>
            )}
            {row.payments > largest.length ? (
              <p className="text-xs leading-4 text-gray-500">
                Every payment is in the {monthName(month)} export.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </DetailSheet>
  );
}
