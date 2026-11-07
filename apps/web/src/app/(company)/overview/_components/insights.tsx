"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { ArrowRightIcon, DownloadIcon, SparkleIcon } from "lucide-react";
import Link from "next/link";

import type {
  ReportSpending,
  SpendingOverview,
} from "@expendi-business/shared";

import type { BarRow } from "./bar-list";
import { textLinkClass } from "~/components/data/actions";
import { Money } from "~/components/data/money";
import { Skel } from "~/components/data/states";
import { EntityMark } from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { formatIsoDate } from "~/lib/dates";
import {
  monthAbbr,
  monthLabel,
  monthName,
  shiftMonth,
} from "../../reports/_components/report-month";
import { ColumnChart } from "../../reports/_components/viz/column-chart";
import { MonthChip } from "../../reports/_components/viz/month-chip";
import {
  compact,
  kesValue,
  niceScale,
  percentChange,
} from "../../reports/_components/viz/scale";
import {
  MiniTable,
  TableToggle,
} from "../../reports/_components/viz/table-toggle";
import { BarList } from "./bar-list";
import {
  biggestRise,
  categoryBars,
  largestPayments,
  spendingSeries,
} from "./overview-display";

const kes = (value: number) =>
  `KES ${Math.round(value).toLocaleString("en-KE")}`;

/** "KES 1.92M" with the code small and muted, for the cards' figures. */
function ShortKes({ value }: { value: number }): JSX.Element {
  return (
    <span className="whitespace-nowrap">
      <span
        data-ccy=""
        className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-gray-500"
      >
        KES
      </span>{" "}
      {compact(value)}
    </span>
  );
}

function Card({
  id,
  title,
  href,
  insight,
  kpis,
  index,
  children,
}: {
  id: string;
  title: string;
  href: string;
  insight: string | null;
  kpis: readonly (readonly [string, ReactNode])[];
  index: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <article
      aria-labelledby={id}
      style={{ animationDelay: `${String(140 + index * 70)}ms` }}
      className="min-w-0 rounded-panel border border-gray-200 bg-surface p-5 shadow-panel motion-safe:animate-rise"
    >
      <h3>
        <Link
          id={id}
          href={href}
          className="group/title inline-flex items-center gap-1.5 rounded-[4px] text-lg leading-[26px] font-(--w-title) text-gray-900"
        >
          {title}
          <ArrowRightIcon
            aria-hidden="true"
            className="size-4 text-gray-400 transition-[transform,color] duration-200 ease-out-expo group-hover/title:translate-x-[3px] group-hover/title:text-gray-700"
          />
        </Link>
      </h3>
      {insight ? (
        <p className="mt-1 flex items-start gap-1.5 text-sm leading-5 text-gray-700">
          <SparkleIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-brand-600"
          />
          <span>{insight}</span>
        </p>
      ) : null}
      <dl className="my-[18px] grid grid-cols-2 gap-4">
        {kpis.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs leading-4 text-gray-500">{label}</dt>
            <dd className="mt-1 text-2xl leading-8 font-(--w-figure) tracking-[-0.015em] [overflow-wrap:anywhere]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {children}
    </article>
  );
}

function Legend({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="mb-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs leading-4 text-gray-600"
    >
      {children}
    </div>
  );
}

function LegendKey({
  kind,
  children,
}: {
  kind: "selected" | "context" | "tick";
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        className={cn(
          kind === "tick"
            ? "h-3 w-0.5 rounded-[1px] bg-gray-600"
            : "size-2.5 rounded-[2px]",
          kind === "selected" && "bg-brand-500",
          kind === "context" && "bg-gray-300",
        )}
      />
      {children}
    </span>
  );
}

function ChartUnavailable({
  trend,
  height,
}: {
  trend: UseQueryResult<ReportSpending>;
  height: number;
}): JSX.Element {
  if (trend.isError) {
    return (
      <p className="py-6 text-sm text-gray-600" role="alert">
        This chart didn&apos;t load.{" "}
        <button
          type="button"
          onClick={() => void trend.refetch()}
          className={cn("border-0 bg-transparent", textLinkClass)}
        >
          Try again
        </button>
      </p>
    );
  }
  return <Skel width="100%" height={height} />;
}

function changeSentence(
  subject: string,
  current: number,
  previous: number,
  previousMonth: string,
): string | null {
  if (previous <= 0 || current <= 0) return null;
  const change = Math.round((current / previous - 1) * 100);
  if (change === 0) {
    return `${subject} is the same as in ${monthName(previousMonth)}.`;
  }
  return `${subject} is ${change > 0 ? "up" : "down"} ${String(Math.abs(change))}% on ${monthName(previousMonth)}.`;
}

/**
 * How the chosen month went: money out over six months, where it went
 * outside payroll, the largest payments and the overview headings.
 */
export function Insights({
  data,
  trend,
  thisMonth,
  onMonthChange,
}: {
  data: SpendingOverview;
  trend: UseQueryResult<ReportSpending>;
  thisMonth: string;
  onMonthChange: (month: string) => void;
}): JSX.Element {
  const month = data.month;
  const partial = month === thisMonth;
  const reportHref = `/reports?month=${month}`;
  return (
    <section aria-labelledby="insights-title" className="mt-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h2
          id="insights-title"
          className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]"
        >
          {partial
            ? `How ${monthName(month)} is going`
            : `How ${monthName(month)} went`}
        </h2>
        <MonthChip
          month={month}
          thisMonth={thisMonth}
          onChange={onMonthChange}
        />
        <Button
          asChild
          variant="ghost"
          size="md"
          className="ml-auto max-[600px]:ml-0"
        >
          <Link href={reportHref}>
            <DownloadIcon aria-hidden="true" />
            Export {monthName(month)}
          </Link>
        </Button>
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4">
        <MoneyOutCard data={data} trend={trend} href={reportHref} />
        <WhereItWentCard data={data} trend={trend} href={reportHref} />
        <LargestPaymentsCard data={data} trend={trend} href={reportHref} />
        <HeadingsCard data={data} href={reportHref} />
      </div>
    </section>
  );
}

function outsidePayroll(
  data: SpendingOverview,
  period: "currentKes" | "previousKes",
): number {
  const salaries = data.headings.find((row) => row.id === "salaries");
  return kesValue(data[period]) - (salaries ? kesValue(salaries[period]) : 0);
}

function MoneyOutCard({
  data,
  trend,
  href,
}: {
  data: SpendingOverview;
  trend: UseQueryResult<ReportSpending>;
  href: string;
}): JSX.Element {
  const outside = outsidePayroll(data, "currentKes");
  const series = trend.data ? spendingSeries(trend.data) : null;
  const selected = series ? series.months.indexOf(data.month) : -1;
  return (
    <Card
      id="insight-money"
      index={0}
      title="Money out"
      href={href}
      insight={changeSentence(
        "Spending outside payroll",
        outside,
        outsidePayroll(data, "previousKes"),
        data.previousMonth,
      )}
      kpis={[
        [
          "Total out",
          <ShortKes key="total" value={kesValue(data.currentKes)} />,
        ],
        ["Outside payroll", <ShortKes key="outside" value={outside} />],
      ]}
    >
      <Legend>
        <LegendKey kind="selected">{monthName(data.month)}</LegendKey>
        <LegendKey kind="context">The months before</LegendKey>
      </Legend>
      {series ? (
        <>
          <ColumnChart
            labels={series.months.map(monthAbbr)}
            values={series.total}
            selected={selected}
            height={200}
            axis
            ariaLabel={`Money out by month, last ${String(series.months.length)} months. ${monthLabel(data.month)}: ${kes(series.total[selected] ?? 0)}. Use the arrow keys to read each month.`}
            tip={(index) => {
              const month = series.months[index] ?? data.month;
              const before = index > 0 ? (series.total[index - 1] ?? 0) : 0;
              const change = percentChange(series.total[index] ?? 0, before);
              return {
                head: monthLabel(month),
                rows: [
                  {
                    key: index === selected ? "selected" : "context",
                    value: kes(series.total[index] ?? 0),
                    label: "Money out",
                  },
                  {
                    key: "none",
                    value: kes(series.outsidePayroll[index] ?? 0),
                    label: "Outside payroll",
                  },
                ],
                foot:
                  change === null
                    ? null
                    : `${change} on ${monthName(shiftMonth(month, -1))}`,
              };
            }}
          />
          <div className="mt-3">
            <TableToggle>
              <MiniTable
                caption="Money out by month, in KES"
                head={["Month", "Money out", "Outside payroll"]}
              >
                {series.months.map((month, index) => (
                  <tr
                    key={month}
                    data-selected={index === selected || undefined}
                  >
                    <th scope="row">{monthLabel(month)}</th>
                    <td>{kes(series.total[index] ?? 0)}</td>
                    <td>{kes(series.outsidePayroll[index] ?? 0)}</td>
                  </tr>
                ))}
              </MiniTable>
            </TableToggle>
          </div>
        </>
      ) : (
        <ChartUnavailable trend={trend} height={200} />
      )}
    </Card>
  );
}

function WhereItWentCard({
  data,
  trend,
  href,
}: {
  data: SpendingOverview;
  trend: UseQueryResult<ReportSpending>;
  href: string;
}): JSX.Element {
  const bars = trend.data ? categoryBars(trend.data) : null;
  const rise = bars ? biggestRise(bars) : null;
  const top = bars?.[0];
  const max = bars
    ? niceScale(
        Math.max(1, ...bars.flatMap((bar) => [bar.current, bar.previous])),
        3,
      ).top
    : 1;
  const month = monthName(data.month);
  const before = monthName(data.previousMonth);
  const rows: BarRow[] = (bars ?? []).map((bar) => {
    const change = percentChange(bar.current, bar.previous);
    return {
      id: bar.id,
      name: bar.name,
      value: bar.current,
      previous: bar.previous,
      valueText: <ShortKes value={bar.current} />,
      delta: change === "Same" ? "same" : change,
      up: bar.previous > 0 && bar.current / bar.previous - 1 >= 0.2,
      ariaLabel: `${bar.name}: ${kes(bar.current)} in ${month}, ${kes(bar.previous)} in ${before}${change ? `, ${change}` : ""}`,
      tip: {
        head: bar.name,
        rows: [
          { key: "selected", value: kes(bar.current), label: month },
          { key: "tick", value: kes(bar.previous), label: before },
        ],
        foot: change ? `${change} on ${before}` : null,
      },
    };
  });
  return (
    <Card
      id="insight-categories"
      index={1}
      title="Where it went"
      href={href}
      insight={
        rise && rise.share > 0
          ? `${rise.name} drove ${String(rise.share)}% of the increase outside payroll.`
          : null
      }
      kpis={[
        ["Biggest category", top ? top.name : "None"],
        [
          "Biggest change",
          rise ? `${rise.name} +${String(rise.percent)}%` : "None",
        ],
      ]}
    >
      {bars ? (
        bars.length === 0 ? (
          <p className="text-sm text-gray-600">
            Nothing paid outside payroll in {month} or {before}.
          </p>
        ) : (
          <>
            <Legend>
              <LegendKey kind="selected">{month}</LegendKey>
              <LegendKey kind="tick">{before}</LegendKey>
            </Legend>
            <BarList
              label={`Spending outside payroll by category, ${month} against ${before}`}
              rows={rows}
              max={max}
            />
          </>
        )
      ) : (
        <ChartUnavailable trend={trend} height={180} />
      )}
    </Card>
  );
}

function LargestPaymentsCard({
  data,
  trend,
  href,
}: {
  data: SpendingOverview;
  trend: UseQueryResult<ReportSpending>;
  href: string;
}): JSX.Element {
  const payments = trend.data ? largestPayments(trend.data) : null;
  const categories = new Map(
    (trend.data?.categories ?? []).map((category) => [
      category.id,
      category.name,
    ]),
  );
  const total =
    payments?.reduce((sum, payment) => sum + kesValue(payment.amountKes), 0) ??
    0;
  const outside = outsidePayroll(data, "currentKes");
  const share = outside > 0 ? Math.round((total / outside) * 100) : null;
  return (
    <Card
      id="insight-largest"
      index={2}
      title="Largest payments"
      href={href}
      insight={
        payments && payments.length > 0 && share !== null
          ? `The ${payments.length === 1 ? "largest payment was" : `${String(payments.length)} largest were`} ${String(share)}% of spending outside payroll.`
          : null
      }
      kpis={[
        [
          `Top ${String(payments?.length ?? 5)} together`,
          <ShortKes key="top" value={total} />,
        ],
        [
          "Share outside payroll",
          share === null ? "None" : `${String(share)}%`,
        ],
      ]}
    >
      {payments ? (
        payments.length === 0 ? (
          <p className="text-sm text-gray-600">
            Nothing paid outside payroll in {monthName(data.month)}.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {payments.map((payment, index) => (
              <li
                key={payment.id}
                className="grid grid-cols-[16px_32px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 not-first:border-t not-first:border-hairline"
              >
                <span className="text-sm text-gray-500 tabular-nums">
                  {index + 1}
                </span>
                <EntityMark
                  name={payment.personName ?? payment.name}
                  kind={payment.personName ? "person" : "business"}
                />
                <div className="min-w-0">
                  <p className="truncate text-base leading-6 font-(--w-name)">
                    {payment.name}
                  </p>
                  <p className="truncate text-xs leading-4 text-gray-500">
                    {[
                      payment.personName ?? categories.get(payment.categoryId),
                      formatIsoDate(payment.date).replace(/ \d{4}$/, ""),
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
                <span className="text-right text-base font-(--w-amount) whitespace-nowrap">
                  <Money amount={payment.amountKes} currency="KES" />
                </span>
              </li>
            ))}
          </ol>
        )
      ) : (
        <ChartUnavailable trend={trend} height={220} />
      )}
    </Card>
  );
}

function HeadingsCard({
  data,
  href,
}: {
  data: SpendingOverview;
  href: string;
}): JSX.Element {
  const month = monthName(data.month);
  const before = monthName(data.previousMonth);
  const headings = data.headings.map((row) => ({
    ...row,
    current: kesValue(row.currentKes),
    previous: kesValue(row.previousKes),
  }));
  const value = (id: string) =>
    headings.find((row) => row.id === id)?.current ?? 0;
  const max = niceScale(
    Math.max(1, ...headings.flatMap((row) => [row.current, row.previous])),
    3,
  ).top;
  const moved = headings
    .filter((row) => row.previous > 0 && row.current > 0)
    .slice()
    .sort(
      (a, b) =>
        Math.abs(b.current / b.previous - 1) -
        Math.abs(a.current / a.previous - 1),
    )[0];
  return (
    <Card
      id="insight-headings"
      index={3}
      title="By heading"
      href={href}
      insight={
        moved
          ? changeSentence(
              moved.name,
              moved.current,
              moved.previous,
              data.previousMonth,
            )
          : null
      }
      kpis={[
        [
          "Salaries & personnel",
          <ShortKes key="salaries" value={value("salaries")} />,
        ],
        ["Petty cash", <ShortKes key="petty" value={value("petty_cash")} />],
      ]}
    >
      <Legend>
        <LegendKey kind="selected">{month}</LegendKey>
        <LegendKey kind="tick">{before}</LegendKey>
      </Legend>
      <BarList
        label={`Money out by overview heading, ${month} against ${before}`}
        max={max}
        rows={headings.map((row) => {
          const change = percentChange(row.current, row.previous);
          return {
            id: row.id,
            name: row.name,
            value: row.current,
            previous: row.previous,
            valueText: <ShortKes value={row.current} />,
            delta: change === "Same" ? "same" : change,
            up: row.previous > 0 && row.current / row.previous - 1 >= 0.2,
            ariaLabel: `${row.name}: ${kes(row.current)} in ${month}, ${kes(row.previous)} in ${before}${change ? `, ${change}` : ""}`,
            tip: {
              head: row.name,
              rows: [
                { key: "selected", value: kes(row.current), label: month },
                { key: "tick", value: kes(row.previous), label: before },
              ],
              foot: change ? `${change} on ${before}` : null,
            },
          };
        })}
      />
    </Card>
  );
}
