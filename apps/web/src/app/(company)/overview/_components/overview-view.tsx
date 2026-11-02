"use client";

import type { JSX, ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import type {
  CashObligation,
  OverviewPayment,
  OverviewPerson,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAction,
  obligationAmount,
  overviewKes,
} from "@expendi-business/shared";

import {
  cellClass,
  headCellClass,
  inputClass,
  linkClass,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatUsdc } from "~/lib/money";

export const overviewKeys = {
  month: (organizationId: string, month: string | undefined) =>
    ["overview", organizationId, "month", month ?? "current"] as const,
  person: (organizationId: string, personId: string) =>
    ["overview", organizationId, "people", personId] as const,
};

const CHANNEL_LABELS: Record<OverviewPayment["channel"], string> = {
  expendi: "Through Expendi",
  outside: "Paid outside Expendi",
  float: "Petty cash spending",
};

const cardClass = "rounded-lg border border-stone-200 bg-white p-4";

/**
 * The spending overview (spec §6.24) from the same API and wording as the
 * app's home screen: every figure is the API's, never added up here.
 * Accountants see it all, with View in place of Pay.
 */
export function OverviewView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyOverview
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyOverview({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const { api } = useAuth();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const overview = useQuery({
    queryKey: overviewKeys.month(organizationId, month),
    queryFn: () => api.getOverview(organizationId, month),
    placeholderData: keepPreviousData,
  });

  if (overview.isPending) {
    return <p className="text-sm text-stone-500">Loading the overview…</p>;
  }
  if (overview.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(overview.error)}</p>
        <button
          type="button"
          onClick={() => void overview.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }

  const data = overview.data;
  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="mt-1 text-sm text-stone-600">
            Where the money is going, what&apos;s owed and what&apos;s due in
            the next 30 days. Months follow Nairobi time.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-sm">
            Month
            <input
              type="month"
              value={month ?? data.month}
              onChange={(event) => setMonth(event.target.value || undefined)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            onClick={() => void overview.refetch()}
            disabled={overview.isFetching}
            className={secondaryButton}
          >
            {overview.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <CashCheck cash={data.cash} />

      <Section title="Where is the money going?">
        <p className="text-2xl font-semibold tabular-nums">
          {overviewKes(data.currentKes)}
        </p>
        <p className="mt-1 text-sm text-stone-600">
          Money out in {data.month}; {overviewKes(data.previousKes)} in{" "}
          {data.previousMonth}.
        </p>
        <div className="mt-4 grid gap-6 xl:grid-cols-2">
          <Breakdown
            label="Heading"
            rows={data.headings}
            month={data.month}
            previousMonth={data.previousMonth}
          />
          <Breakdown
            label="Category"
            rows={data.categories}
            month={data.month}
            previousMonth={data.previousMonth}
          />
        </div>
      </Section>

      <Section title="What is outstanding?">
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-4">
            <Obligations
              title={`Overdue (${String(data.outstanding.overdue.length)})`}
              rows={data.outstanding.overdue}
              canAct={canAct}
              empty="Nothing overdue."
            />
            <Obligations
              title={`Due today (${String(data.outstanding.dueToday.length)})`}
              rows={data.outstanding.dueToday}
              canAct={canAct}
              empty="Nothing due today."
            />
          </div>
          <div className="space-y-4">
            <ExpenseList
              title={`Claims waiting for approval (${String(data.outstanding.claims.length)})`}
              rows={data.outstanding.claims}
              href="/approvals"
              empty="No claims waiting."
            />
            <ExpenseList
              title={`Petty cash without a receipt (${String(data.outstanding.noReceipt.length)})`}
              rows={data.outstanding.noReceipt}
              href="/expenses?kind=petty_cash"
              empty="Every petty cash purchase has a receipt."
            />
          </div>
        </div>
      </Section>

      <Section title="What needs to be paid next?">
        <Obligations
          title={`Bills and payroll runs through ${formatIsoDate(data.cash.through)}, overdue first`}
          rows={data.cash.obligations}
          canAct={canAct}
          empty="Nothing due in the next 30 days."
        />
      </Section>

      <Section title="What has been paid?">
        <RecentPayments
          rows={data.recentPayments}
          month={data.month}
          previousMonth={data.previousMonth}
        />
      </Section>

      <Section title="Per person">
        <People organizationId={organizationId} people={data.people} />
      </Section>
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={cardClass}>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <p className="py-2 text-sm text-stone-500">{children}</p>;
}

function CashCheck({ cash }: { cash: SpendingOverview["cash"] }): JSX.Element {
  const outsideLine = cashOutsideLine(cash);
  const tone =
    cash.status === "covered"
      ? "text-emerald-800"
      : cash.status === "short"
        ? "text-error-700"
        : "text-amber-900";
  return (
    <section aria-labelledby="cash-check" className={cardClass}>
      <p className="text-sm text-stone-600">
        Cash check · {formatIsoDate(cash.today)} to{" "}
        {formatIsoDate(cash.through)}
      </p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="cash-check" className={`text-2xl font-semibold ${tone}`}>
          {cashHeadline(cash)}
        </h2>
        {cash.unknownAmounts > 0 ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {cash.unknownAmounts === 1
              ? "1 payment has no amount yet"
              : `${String(cash.unknownAmounts)} payments have no amount yet`}
          </span>
        ) : null}
      </div>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-stone-600">Wallet balance</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {formatUsdc(cash.balanceUsdc)} USDC
          </dd>
          <dd className="text-sm text-stone-600 tabular-nums">
            {cash.balanceKes === null
              ? "KES rate unavailable"
              : overviewKes(cash.balanceKes)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-stone-600">
            Available after payments being made
          </dt>
          <dd className="mt-1 font-medium tabular-nums">
            {cash.availableKes === null
              ? "Unavailable"
              : overviewKes(cash.availableKes)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-stone-600">To pay through Expendi</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {overviewKes(cash.totalKes)}
          </dd>
        </div>
      </dl>
      {outsideLine === null ? null : (
        <p className="mt-4 text-sm text-stone-600">{outsideLine}</p>
      )}
      <p className="mt-4 text-sm text-stone-600">
        {cashFootnote(cash)}{" "}
        {cash.rate === null
          ? "Paycrest's KES rate is unavailable right now."
          : `Today's rate: KES ${cash.rate} per USDC.`}
      </p>
    </section>
  );
}

function Breakdown({
  label,
  rows,
  month,
  previousMonth,
}: {
  label: string;
  rows: SpendingOverview["headings"];
  month: string;
  previousMonth: string;
}): JSX.Element {
  if (rows.length === 0) {
    return <Empty>No spending in either month.</Empty>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              {label}
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              {month}
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              {previousMonth}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-stone-200">
              <td className={cellClass}>{row.name}</td>
              <td
                className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
              >
                {overviewKes(row.currentKes)}
              </td>
              <td
                className={`${cellClass} text-right whitespace-nowrap text-stone-600 tabular-nums`}
              >
                {overviewKes(row.previousKes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Where a due payment is paid or, for a forecast, its schedule. */
function obligationHref(row: CashObligation): string {
  switch (row.kind) {
    case "bill":
      return `/bills?billId=${row.id}`;
    case "payroll":
      return `/payroll?runId=${row.id}`;
    case "forecast":
      return row.heading === "salaries"
        ? "/payroll"
        : `/recurring?itemId=${row.id}`;
  }
}

function Obligations({
  title,
  rows,
  canAct,
  empty,
}: {
  title: string;
  rows: readonly CashObligation[];
  canAct: boolean;
  empty: string;
}): JSX.Element {
  return (
    <div>
      <h3 className="text-sm font-medium text-stone-700">{title}</h3>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y divide-stone-200">
          {rows.map((row) => (
            <li
              key={`${row.kind}:${row.id}:${row.dueOn}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="text-sm font-medium">{row.name}</p>
                <p className="text-xs text-stone-500">
                  {formatIsoDate(row.dueOn)} ·{" "}
                  {row.kind === "forecast"
                    ? "not billed yet"
                    : row.status.replaceAll("_", " ")}{" "}
                  ·{" "}
                  {row.payVia === "outside"
                    ? "Paid outside Expendi"
                    : "Through Expendi"}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm whitespace-nowrap tabular-nums">
                  {obligationAmount(row)}
                </span>
                <Link href={obligationHref(row)} className={linkClass}>
                  {canAct ? obligationAction(row) : "View"}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExpenseList({
  title,
  rows,
  href,
  empty,
}: {
  title: string;
  rows: SpendingOverview["outstanding"]["claims"];
  href: string;
  empty: string;
}): JSX.Element {
  return (
    <div>
      <h3 className="text-sm font-medium text-stone-700">
        <Link href={href} className={linkClass}>
          {title}
        </Link>
      </h3>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y divide-stone-200">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex justify-between gap-4 py-2 text-sm"
            >
              <span>{row.name}</span>
              <span className="whitespace-nowrap tabular-nums">
                {overviewKes(row.amountKes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentPayments({
  rows,
  month,
  previousMonth,
}: {
  rows: readonly OverviewPayment[];
  month: string;
  previousMonth: string;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <Empty>
        No payments in {previousMonth} or {month}.
      </Empty>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Date
            </th>
            <th scope="col" className={headCellClass}>
              Paid to
            </th>
            <th scope="col" className={headCellClass}>
              How
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-stone-200">
              <td className={`${cellClass} whitespace-nowrap`}>
                {formatIsoDate(row.date)}
              </td>
              <td className={cellClass}>
                {row.name}
                <span className="block text-xs text-stone-500">
                  {row.categoryName}
                </span>
              </td>
              <td className={cellClass}>{CHANNEL_LABELS[row.channel]}</td>
              <td
                className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
              >
                {overviewKes(row.amountKes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function People({
  organizationId,
  people,
}: {
  organizationId: string;
  people: SpendingOverview["people"];
}): JSX.Element {
  const [personId, setPersonId] = useState("");
  return (
    <div>
      <label className="block max-w-sm text-sm">
        Person
        <select
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
          className={inputClass}
        >
          <option value="">Choose a person</option>
          {people.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {personId ? (
        <PersonDetail
          key={personId}
          organizationId={organizationId}
          personId={personId}
        />
      ) : null}
    </div>
  );
}

function PersonDetail({
  organizationId,
  personId,
}: {
  organizationId: string;
  personId: string;
}): JSX.Element {
  const { api } = useAuth();
  const person = useQuery({
    queryKey: overviewKeys.person(organizationId, personId),
    queryFn: () => api.getOverviewPerson(organizationId, personId),
  });
  if (person.isPending) {
    return <p className="mt-4 text-sm text-stone-500">Loading…</p>;
  }
  if (person.isError) {
    return (
      <div className="mt-4 text-sm text-error-700" role="alert">
        <p>{describeApiError(person.error)}</p>
        <button
          type="button"
          onClick={() => void person.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }
  return <PersonFigures data={person.data} />;
}

function PersonFigures({ data }: { data: OverviewPerson }): JSX.Element {
  return (
    <div className="mt-4 grid gap-6 md:grid-cols-2">
      <div className="space-y-4">
        <PersonList title="Salary" empty="No salary set up.">
          {data.salaries.map((row) => (
            <li key={row.id}>
              {overviewKes(row.amountKes)} · {row.active ? "Active" : "Ended"}
              {row.nextDueOn ? ` · next ${formatIsoDate(row.nextDueOn)}` : ""}
            </li>
          ))}
        </PersonList>
        <PersonList title="Petty cash floats" empty="No floats.">
          {data.floats.map((row) => (
            <li key={row.id}>
              {overviewKes(row.leftKes)} left · {row.status}
            </li>
          ))}
        </PersonList>
      </div>
      <div className="space-y-4">
        <PersonList title="Claims" empty="No claims.">
          {data.claims.map((row) => (
            <li key={row.id}>
              {row.name} · {overviewKes(row.amountKes)} ·{" "}
              {row.status.replaceAll("_", " ")}
            </li>
          ))}
        </PersonList>
        <PersonList title="Payments" empty="No payments.">
          {data.payments.map((row) => (
            <li key={row.id}>
              {formatIsoDate(row.date)} · {row.name} ·{" "}
              {overviewKes(row.amountKes)}
            </li>
          ))}
        </PersonList>
      </div>
    </div>
  );
}

function PersonList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode[];
}): JSX.Element {
  return (
    <div>
      <h3 className="text-sm font-medium text-stone-700">{title}</h3>
      {children.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">{children}</ul>
      )}
    </div>
  );
}
