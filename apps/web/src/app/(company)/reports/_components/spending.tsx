"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { ChartColumnIcon, TagIcon } from "lucide-react";
import Link from "next/link";

import type { ReportSpending } from "@expendi-business/shared";

import type {
  CategoryRow,
  CategorySortKey,
  ChangeContext,
  SpendingMonthView,
} from "./reports-display";
import type { TipContent, TipKey } from "./viz/chart-tip";
import type { SortState } from "~/components/data/table";
import { Money } from "~/components/data/money";
import { ResultsBody, ResultsPanel } from "~/components/data/results";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import {
  DataRow,
  DataTable,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  Td,
  Th,
} from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { monthAbbr, monthLabel, shiftMonth } from "./report-month";
import {
  categoryMeta,
  changeLine,
  deltaText,
  HEADING_KEYS,
  headingLabel,
  isNotableRise,
} from "./reports-display";
import { ColumnChart } from "./viz/column-chart";
import { MiniTable, TableToggle } from "./viz/table-toggle";

const kesText = (value: number) => `KES ${value.toLocaleString("en-KE")}`;

function soFar(month: string, thisMonth: string, text = " (so far)"): string {
  return month === thisMonth ? text : "";
}

/** Money out by month and by heading, then the category table. */
export function SpendingBody({
  spending,
  months,
  rows,
  context,
  canAct,
  sort,
  onSort,
  openCategoryId,
  onOpenCategory,
}: {
  spending: UseQueryResult<ReportSpending>;
  months: readonly SpendingMonthView[];
  rows: readonly CategoryRow[];
  context: ChangeContext;
  canAct: boolean;
  sort: SortState<CategorySortKey>;
  onSort: (key: CategorySortKey) => void;
  openCategoryId: string | null;
  onOpenCategory: (id: string) => void;
}): JSX.Element {
  if (spending.isPending) return <SpendingSkeleton />;
  if (spending.isError) {
    return (
      <div className="mt-4 rounded-panel border border-gray-200 bg-surface">
        <ErrorState
          title="Spending didn't load"
          onRetry={() => void spending.refetch()}
        />
      </div>
    );
  }
  if (months.every((month) => month.total === 0)) {
    return (
      <div className="mt-4 rounded-panel border border-gray-200 bg-surface">
        <EmptyState
          icon={ChartColumnIcon}
          title={`Nothing paid out in these ${String(months.length)} months`}
          action={
            canAct ? (
              <Button asChild variant="outline" size="md">
                <Link href="/bills">Go to Bills</Link>
              </Button>
            ) : null
          }
        >
          Bills, payroll runs, reimbursements and petty cash show up here once
          they&apos;re paid.
        </EmptyState>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "transition-opacity duration-200",
        spending.isPlaceholderData && "opacity-50",
      )}
    >
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4">
        <MoneyOutCard months={months} context={context} />
        <HeadingCard months={months} context={context} />
      </div>
      <CategoryPanel
        rows={rows}
        months={months}
        context={context}
        sort={sort}
        onSort={onSort}
        openCategoryId={openCategoryId}
        onOpenCategory={onOpenCategory}
      />
    </div>
  );
}

function VizCard({
  titleId,
  title,
  sub,
  children,
  foot,
}: {
  titleId: string;
  title: string;
  sub: string;
  children: ReactNode;
  foot: ReactNode;
}): JSX.Element {
  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col rounded-panel border border-gray-200 bg-surface p-5 text-sm shadow-panel max-[600px]:p-4"
    >
      <h3
        id={titleId}
        className="text-lg leading-[26px] font-(--w-title) text-gray-900"
      >
        {title}
      </h3>
      <p className="mt-0.5 text-gray-500">{sub}</p>
      {children}
      <div className="mt-auto pt-3">{foot}</div>
    </article>
  );
}

function tipKey(month: string, selected: string): TipKey {
  return month === selected ? "selected" : "context";
}

function MoneyOutCard({
  months,
  context,
}: {
  months: readonly SpendingMonthView[];
  context: ChangeContext;
}): JSX.Element {
  const { month: selected, thisMonth } = context;
  const index = months.findIndex((entry) => entry.month === selected);
  const current = months[index];
  const tip = (at: number): TipContent => {
    const entry = months[at];
    if (!entry) return { head: "", rows: [] };
    return {
      head: `${monthLabel(entry.month)}${soFar(entry.month, thisMonth)}`,
      rows: [
        {
          key: tipKey(entry.month, selected),
          value: kesText(entry.total),
          label: "Money out",
        },
        ...HEADING_KEYS.map((key) => ({
          value: kesText(entry.headings[key]),
          label: headingLabel(key),
        })),
      ],
      foot: changeLine(entry.total, entry.previous, {
        ...context,
        month: entry.month,
      }),
    };
  };
  return (
    <VizCard
      titleId="money-out-title"
      title="Money out by month"
      sub={`Every payment out, salaries included. ${monthLabel(selected)}${soFar(selected, thisMonth)} is highlighted.`}
      foot={
        <TableToggle>
          <MiniTable
            caption="Money out by month"
            head={["Month", "Money out (KES)", "Change"]}
          >
            {months.map((entry) => (
              <tr
                key={entry.month}
                data-selected={entry.month === selected || undefined}
              >
                <th scope="row">
                  {monthLabel(entry.month)}
                  {soFar(entry.month, thisMonth)}
                </th>
                <td>{entry.total.toLocaleString("en-KE")}</td>
                <td>{deltaText(entry.total, entry.previous)}</td>
              </tr>
            ))}
          </MiniTable>
        </TableToggle>
      }
    >
      <div className="mt-4">
        <ColumnChart
          labels={months.map((entry) => monthAbbr(entry.month))}
          values={months.map((entry) => entry.total)}
          selected={index}
          height={(width) => (width > 0 && width < 520 ? 240 : 340)}
          axis
          ariaLabel={`Money out by month. ${monthLabel(selected)}${soFar(selected, thisMonth)}: ${kesText(current?.total ?? 0)}. Use the arrow keys to read each month.`}
          tip={tip}
        />
      </div>
    </VizCard>
  );
}

function HeadingCard({
  months,
  context,
}: {
  months: readonly SpendingMonthView[];
  context: ChangeContext;
}): JSX.Element {
  const { month: selected, thisMonth } = context;
  const index = months.findIndex((entry) => entry.month === selected);
  const current = months[index];
  return (
    <VizCard
      titleId="heading-title"
      title="By heading"
      sub="The four overview headings. Each chart has its own scale."
      foot={
        <TableToggle>
          <MiniTable
            caption="Money out by heading and month, in KES"
            head={["Month", ...HEADING_KEYS.map(headingLabel)]}
          >
            {months.map((entry) => (
              <tr
                key={entry.month}
                data-selected={entry.month === selected || undefined}
              >
                <th scope="row">{monthLabel(entry.month)}</th>
                {HEADING_KEYS.map((key) => (
                  <td key={key}>
                    {entry.headings[key].toLocaleString("en-KE")}
                  </td>
                ))}
              </tr>
            ))}
          </MiniTable>
        </TableToggle>
      }
    >
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 max-[600px]:gap-4">
        {HEADING_KEYS.map((key) => {
          const value = current?.headings[key] ?? 0;
          const previous = current?.previousHeadings[key] ?? 0;
          return (
            <div key={key} className="min-w-0">
              <p className="text-xs leading-4 font-(--w-ui) text-gray-600">
                {headingLabel(key)}
              </p>
              <p className="mt-0.5 text-base leading-6 font-(--w-amount)">
                <Money
                  amount={current?.headingsKes[key] ?? "0"}
                  currency="KES"
                />
              </p>
              <p className="text-xs leading-4 text-gray-500">
                {changeLine(value, previous, context)}
              </p>
              <div className="mt-2">
                <ColumnChart
                  labels={months.map((entry) => monthAbbr(entry.month))}
                  values={months.map((entry) => entry.headings[key])}
                  selected={index}
                  height={96}
                  axis={false}
                  ariaLabel={`${headingLabel(key)} by month: ${kesText(value)} in ${monthLabel(selected)}${soFar(selected, thisMonth)}. Use the arrow keys to read each month.`}
                  tip={(at) => {
                    const entry = months[at];
                    return {
                      head: entry
                        ? `${monthLabel(entry.month)}${soFar(entry.month, thisMonth)}`
                        : "",
                      rows: entry
                        ? [
                            {
                              key: tipKey(entry.month, selected),
                              value: kesText(entry.headings[key]),
                              label: headingLabel(key),
                            },
                          ]
                        : [],
                    };
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </VizCard>
  );
}

/** A category's months as a thin gray line, the chosen month dotted. */
export function Spark({
  values,
  selected,
}: {
  values: readonly number[];
  selected: number;
}): JSX.Element {
  const W = 96;
  const H = 28;
  const max = Math.max(...values, 1);
  const x = (index: number) =>
    values.length === 1 ? W / 2 : (index / (values.length - 1)) * (W - 8) + 4;
  const y = (value: number) => H - 4 - (value / max) * (H - 8);
  const path = values
    .map(
      (value, index) =>
        `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`,
    )
    .join("");
  const point = values[selected];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      aria-hidden="true"
      className="block overflow-visible"
    >
      <path
        d={path}
        className="fill-none stroke-gray-400 stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
      />
      {point !== undefined ? (
        <circle
          cx={x(selected)}
          cy={y(point)}
          r={4}
          className="fill-brand-700 stroke-surface stroke-2"
        />
      ) : null}
    </svg>
  );
}

function ChangeText({
  row,
  partial,
  text,
}: {
  row: CategoryRow;
  partial: boolean;
  text: string;
}): JSX.Element {
  const up = !partial && isNotableRise(row.current, row.previous);
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        up ? "font-(--w-ui) text-gray-900" : "text-gray-500",
      )}
    >
      {text}
    </span>
  );
}

function phoneChange(row: CategoryRow, previousMonth: string): string {
  const delta = deltaText(row.current, row.previous);
  if (delta === "Same") return `Same as ${monthAbbr(previousMonth)}`;
  if (delta === "New") return `New since ${monthAbbr(previousMonth)}`;
  if (delta === "None") return "";
  return `${delta} on ${monthAbbr(previousMonth)}`;
}

function CategoryPanel({
  rows,
  months,
  context,
  sort,
  onSort,
  openCategoryId,
  onOpenCategory,
}: {
  rows: readonly CategoryRow[];
  months: readonly SpendingMonthView[];
  context: ChangeContext;
  sort: SortState<CategorySortKey>;
  onSort: (key: CategorySortKey) => void;
  openCategoryId: string | null;
  onOpenCategory: (id: string) => void;
}): JSX.Element {
  const { month, thisMonth } = context;
  const partial = month === thisMonth;
  const previousMonth = shiftMonth(month, -1);
  const previousLabel = monthLabel(previousMonth);
  const selectedIndex = months.length - 1;
  return (
    <ResultsPanel label="By category">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-gray-200 px-5 pt-[18px] pb-3.5 max-[600px]:p-4">
        <div>
          <h3 className="text-lg leading-[26px] font-(--w-title) text-gray-900">
            By category
          </h3>
          <p className="mt-0.5 text-gray-500">
            {monthLabel(month)}
            {soFar(month, thisMonth, " so far")} against {previousLabel}. Open a
            category for its months and largest payments.
          </p>
        </div>
      </div>
      <ResultsBody>
        <DataTable caption="Spending by category">
          <thead>
            <tr>
              <SortHeader
                label="Category"
                sortKey="name"
                sort={sort}
                onSort={onSort}
              />
              <Th collapse="md">Last {months.length} months</Th>
              <SortHeader
                label={previousLabel}
                sortKey="previous"
                sort={sort}
                onSort={onSort}
                align="end"
              />
              <SortHeader
                label={`${monthLabel(month)}${soFar(month, thisMonth, " so far")}`}
                sortKey="current"
                sort={sort}
                onSort={onSort}
                align="end"
              />
              <SortHeader
                label="Change"
                sortKey="change"
                sort={sort}
                onSort={onSort}
                align="end"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <DataRow
                key={row.id}
                open={openCategoryId === row.id}
                onOpen={() => onOpenCategory(row.id)}
              >
                <Td kind="main">
                  <RowTitle onOpen={() => onOpenCategory(row.id)}>
                    {row.name}
                  </RowTitle>
                  <RowMeta text={categoryMeta(row, month)} />
                </Td>
                <Td collapse="md" className="w-[120px] pt-3.5">
                  <Spark values={row.trend} selected={selectedIndex} />
                </Td>
                <Td align="end">
                  <span className="inline-block pt-0.5 whitespace-nowrap text-gray-600">
                    <Money amount={row.previousKes} currency="KES" />
                  </span>
                </Td>
                <Td align="end">
                  <span className="text-base leading-6 font-(--w-amount) whitespace-nowrap">
                    <Money amount={row.currentKes} currency="KES" />
                  </span>
                </Td>
                <Td align="end">
                  <ChangeText
                    row={row}
                    partial={partial}
                    text={
                      partial ? "So far" : deltaText(row.current, row.previous)
                    }
                  />
                </Td>
              </DataRow>
            ))}
          </tbody>
        </DataTable>
        <PhoneCards label="Categories">
          {rows.map((row) => (
            <PhoneCard
              key={row.id}
              mark={
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-700"
                >
                  <TagIcon className="size-4" />
                </span>
              }
              title={row.name}
              sub={categoryMeta(row, month)}
              aside={
                <span className="inline-flex flex-col items-end">
                  <span className="font-(--w-amount)">
                    <Money amount={row.currentKes} currency="KES" />
                  </span>
                  <ChangeText
                    row={row}
                    partial={partial}
                    text={partial ? "So far" : phoneChange(row, previousMonth)}
                  />
                </span>
              }
              onOpen={() => onOpenCategory(row.id)}
            />
          ))}
        </PhoneCards>
      </ResultsBody>
    </ResultsPanel>
  );
}

function SpendingSkeleton(): JSX.Element {
  return (
    <div aria-busy="true">
      <div
        aria-hidden="true"
        className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4"
      >
        {[0, 1].map((card) => (
          <div
            key={card}
            className="rounded-panel border border-gray-200 bg-surface p-5"
          >
            <Skel width="40%" height={18} />
            <Skel width="65%" height={12} style={{ marginTop: 8 }} />
            <Skel width="100%" height={200} style={{ marginTop: 20 }} />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="mt-4 rounded-panel border border-gray-200 bg-surface p-5"
      >
        {[70, 62, 54, 46, 38].map((width, row) => (
          <Skel
            key={width}
            width={`${String(width)}%`}
            height={14}
            style={{ marginTop: row ? 18 : 0 }}
          />
        ))}
      </div>
    </div>
  );
}
