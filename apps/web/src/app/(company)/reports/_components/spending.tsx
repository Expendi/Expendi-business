"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { ChartColumnIcon, TagIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";

import type { ReportSpending } from "@expendi-business/shared";

import type {
  CategoryRow,
  CategorySortKey,
  ChangeContext,
  SpendingMonthView,
} from "./reports-display";
import type {
  DataTableColumnDef,
  SortState,
} from "~/components/data/data-table";
import type { MonthTip } from "~/components/data/month-bars";
import { PhoneCard, RowMeta, RowTitle } from "~/components/data/cells";
import {
  DataTable,
  DataTableColumnHeader,
  pressedKey,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import { Money } from "~/components/data/money";
import { MonthBars } from "~/components/data/month-bars";
import { ResultsBody, ResultsPanel } from "~/components/data/results";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { MiniTable, TableToggle } from "~/components/data/table-toggle";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { ChartContainer } from "~/components/ui/chart";
import { monthAbbr, monthLabel, shiftMonth } from "./report-month";
import {
  categoryMeta,
  changeLine,
  deltaText,
  HEADING_KEYS,
  headingLabel,
  isNotableRise,
} from "./reports-display";

const kesText = (value: number) => `KES ${value.toLocaleString("en-KE")}`;

const CATEGORY_KEYS: readonly CategorySortKey[] = [
  "name",
  "previous",
  "current",
  "change",
];

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
      <Card className="mt-4 gap-0 py-0 shadow-xs">
        <ErrorState
          title="Spending didn't load"
          onRetry={() => void spending.refetch()}
        />
      </Card>
    );
  }
  if (months.every((month) => month.total === 0)) {
    return (
      <Card className="mt-4 gap-0 py-0 shadow-xs">
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
      </Card>
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
    <Card
      role="article"
      aria-labelledby={titleId}
      className="shadow-xs max-[600px]:[--card-spacing:--spacing(4)]"
    >
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={3}>
          {title}
        </CardTitle>
        <CardDescription>{sub}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
      <CardFooter className="mt-auto block">{foot}</CardFooter>
    </Card>
  );
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
  const tip = (at: number): MonthTip => {
    const entry = months[at];
    if (!entry) return { head: "", rows: [] };
    return {
      head: `${monthLabel(entry.month)}${soFar(entry.month, thisMonth)}`,
      rows: [
        { value: kesText(entry.total), label: "Money out" },
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
      <MonthBars
        labels={months.map((entry) => monthAbbr(entry.month))}
        values={months.map((entry) => entry.total)}
        selected={index}
        axis
        className="h-60 min-[600px]:h-80"
        ariaLabel={`Money out by month. ${monthLabel(selected)}${soFar(selected, thisMonth)}: ${kesText(current?.total ?? 0)}. Use the arrow keys to read each month.`}
        tip={tip}
      />
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
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 max-[600px]:gap-4">
        {HEADING_KEYS.map((key) => {
          const value = current?.headings[key] ?? 0;
          const previous = current?.previousHeadings[key] ?? 0;
          return (
            <div key={key} className="min-w-0">
              <p className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
                {headingLabel(key)}
              </p>
              <p className="mt-0.5 text-base leading-6 font-(--w-amount)">
                <Money
                  amount={current?.headingsKes[key] ?? "0"}
                  currency="KES"
                />
              </p>
              <p className="text-xs leading-4 text-muted-foreground">
                {changeLine(value, previous, context)}
              </p>
              <div className="mt-2">
                <MonthBars
                  labels={months.map((entry) => monthAbbr(entry.month))}
                  values={months.map((entry) => entry.headings[key])}
                  selected={index}
                  axis={false}
                  className="h-28"
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

const SPARK_CONFIG = { value: { label: "Money out" } } as const;

/** A category's months as a thin line, the chosen month dotted. */
export function Spark({
  values,
  selected,
}: {
  values: readonly number[];
  selected: number;
}): JSX.Element {
  const data = values.map((value, index) => ({ index, value }));
  const point = values[selected];
  return (
    <ChartContainer
      config={SPARK_CONFIG}
      aria-hidden="true"
      className="aspect-auto h-7 w-24 justify-start"
    >
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <XAxis dataKey="index" hide />
        <YAxis hide domain={[0, Math.max(...values, 1)]} />
        <Line
          dataKey="value"
          type="linear"
          stroke="var(--muted-foreground)"
          strokeOpacity={0.6}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        {point !== undefined ? (
          <ReferenceDot
            x={selected}
            y={point}
            r={4}
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth={2}
          />
        ) : null}
      </LineChart>
    </ChartContainer>
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
        up ? "font-(--w-ui) text-foreground" : "text-muted-foreground",
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

function categoryColumns({
  monthCount,
  month,
  thisMonth,
  onOpen,
}: {
  monthCount: number;
  month: string;
  thisMonth: string;
  onOpen: (id: string) => void;
}): DataTableColumnDef<CategoryRow>[] {
  const partial = month === thisMonth;
  const previousLabel = monthLabel(shiftMonth(month, -1));
  const currentLabel = `${monthLabel(month)}${soFar(month, thisMonth, " so far")}`;
  return [
    {
      id: "name",
      accessorFn: (row) => row.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Category" />
      ),
      cell: ({ row }) => (
        <>
          <RowTitle onOpen={() => onOpen(row.original.id)}>
            {row.original.name}
          </RowTitle>
          <RowMeta text={categoryMeta(row.original, month)} />
        </>
      ),
      meta: { kind: "main", label: "Category" },
    },
    {
      id: "trend",
      header: `Last ${String(monthCount)} months`,
      enableSorting: false,
      cell: ({ row }) => (
        <Spark values={row.original.trend} selected={monthCount - 1} />
      ),
      meta: {
        collapse: "md",
        className: "w-[120px]",
        label: `Last ${String(monthCount)} months`,
      },
    },
    {
      id: "previous",
      accessorFn: (row) => row.previous,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={previousLabel} />
      ),
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          <Money amount={row.original.previousKes} currency="KES" />
        </span>
      ),
      meta: { align: "end", label: previousLabel },
    },
    {
      id: "current",
      accessorFn: (row) => row.current,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={currentLabel} />
      ),
      cell: ({ row }) => (
        <span className="text-base leading-6 font-(--w-amount) whitespace-nowrap">
          <Money amount={row.original.currentKes} currency="KES" />
        </span>
      ),
      meta: { align: "end", label: currentLabel },
    },
    {
      id: "change",
      accessorFn: (row) => row.current - row.previous,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Change" />
      ),
      cell: ({ row }) => (
        <ChangeText
          row={row.original}
          partial={partial}
          text={
            partial
              ? "So far"
              : deltaText(row.original.current, row.original.previous)
          }
        />
      ),
      meta: { align: "end", label: "Change" },
    },
  ];
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
  const monthCount = months.length;
  const columns = useMemo(
    () =>
      categoryColumns({
        monthCount,
        month,
        thisMonth,
        onOpen: onOpenCategory,
      }),
    [monthCount, month, thisMonth, onOpenCategory],
  );
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    manual: { sorting: true },
    paginate: false,
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(pressedKey(next, sort, CATEGORY_KEYS)),
    },
  });
  return (
    <ResultsPanel label="By category">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border px-5 pt-[18px] pb-3.5 max-[600px]:p-4">
        <div>
          <h3 className="text-lg leading-[26px] font-(--w-title) text-foreground">
            By category
          </h3>
          <p className="mt-0.5 text-muted-foreground">
            {monthLabel(month)}
            {soFar(month, thisMonth, " so far")} against {previousLabel}. Open a
            category for its months and largest payments.
          </p>
        </div>
      </div>
      <ResultsBody>
        <DataTable
          table={table}
          caption="Spending by category"
          phoneLabel="Categories"
          onRowOpen={(row) => onOpenCategory(row.id)}
          openRowId={openCategoryId}
          renderPhoneCard={(row) => (
            <PhoneCard
              key={row.id}
              mark={
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-secondary-foreground"
                >
                  <TagIcon className="size-4" />
                </span>
              }
              title={row.original.name}
              sub={categoryMeta(row.original, month)}
              aside={
                <span className="inline-flex flex-col items-end">
                  <span className="font-(--w-amount)">
                    <Money amount={row.original.currentKes} currency="KES" />
                  </span>
                  <ChangeText
                    row={row.original}
                    partial={partial}
                    text={
                      partial
                        ? "So far"
                        : phoneChange(row.original, previousMonth)
                    }
                  />
                </span>
              }
              onOpen={() => onOpenCategory(row.id)}
            />
          )}
        />
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
            className="rounded-xl border border-border bg-card p-5 shadow-xs"
          >
            <Skel width="40%" height={18} />
            <Skel width="65%" height={12} style={{ marginTop: 8 }} />
            <Skel width="100%" height={200} style={{ marginTop: 20 }} />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="mt-4 rounded-xl border border-border bg-card p-5 shadow-xs"
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
