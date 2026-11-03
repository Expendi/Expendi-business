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

import { linkClass } from "~/components/styles";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  EmptyDescription,
  EmptyHeader,
  Empty as EmptyState,
} from "~/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
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
      <Alert variant="destructive">
        <AlertDescription>{describeApiError(overview.error)}</AlertDescription>
        <Button
          type="button"
          onClick={() => void overview.refetch()}
          className="mt-2"
          variant="outline"
        >
          Try again
        </Button>
      </Alert>
    );
  }

  const data = overview.data;
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Where the money is going, what&apos;s owed and what&apos;s due in
            the next 30 days. Months follow Nairobi time.
          </p>
        </div>
        <FieldGroup className="w-full shrink-0 flex-row items-end gap-3 sm:w-72">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="overview-month">Month</FieldLabel>
            <Input
              id="overview-month"
              type="month"
              value={month ?? data.month}
              onChange={(event) => setMonth(event.target.value || undefined)}
            />
          </Field>
          <Button
            type="button"
            onClick={() => void overview.refetch()}
            disabled={overview.isFetching}
            variant="outline"
          >
            {overview.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </FieldGroup>
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
          <div className="flex flex-col gap-4">
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
          <div className="flex flex-col gap-4">
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <EmptyState className="items-start p-0 py-3 text-left md:p-0 md:py-3">
      <EmptyHeader className="items-start">
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </EmptyState>
  );
}

function CashCheck({ cash }: { cash: SpendingOverview["cash"] }): JSX.Element {
  const outsideLine = cashOutsideLine(cash);
  return (
    <Card aria-labelledby="cash-check">
      <CardHeader>
        <CardDescription>
          Cash check · {formatIsoDate(cash.today)} to{" "}
          {formatIsoDate(cash.through)}
        </CardDescription>
        <CardTitle>
          <h2 id="cash-check">{cashHeadline(cash)}</h2>
        </CardTitle>
        {cash.unknownAmounts > 0 ? (
          <Badge variant="secondary" className="mt-2">
            {cash.unknownAmounts === 1
              ? "1 payment has no amount yet"
              : `${String(cash.unknownAmounts)} payments have no amount yet`}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-5 divide-y divide-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <div>
            <dt className="text-sm text-stone-600">Wallet balance</dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
              {formatUsdc(cash.balanceUsdc)} USDC
            </dd>
            <dd className="text-sm text-stone-600 tabular-nums">
              {cash.balanceKes === null
                ? "KES rate unavailable"
                : overviewKes(cash.balanceKes)}
            </dd>
          </div>
          <div className="pt-5 lg:pt-0 lg:pl-6">
            <dt className="text-sm text-stone-600">
              Available after payments being made
            </dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
              {cash.availableKes === null
                ? "Unavailable"
                : overviewKes(cash.availableKes)}
            </dd>
          </div>
          <div className="pt-5 lg:pt-0 lg:pl-6">
            <dt className="text-sm text-stone-600">To pay through Expendi</dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
              {overviewKes(cash.totalKes)}
            </dd>
          </div>
        </dl>
        {outsideLine === null ? null : (
          <p className="mt-4 text-sm text-stone-600">{outsideLine}</p>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          {cashFootnote(cash)}{" "}
          {cash.rate === null
            ? "Paycrest's KES rate is unavailable right now."
            : `Today's rate: KES ${cash.rate} per USDC.`}
        </p>
      </CardFooter>
    </Card>
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
    <div className="min-w-0">
      <Table aria-label={`Spending by ${label.toLowerCase()}`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{label}</TableHead>
            <TableHead scope="col" className="text-right">
              {month}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {previousMonth}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="min-w-32 max-w-64 whitespace-normal wrap-anywhere">
                {row.name}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {overviewKes(row.currentKes)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {overviewKes(row.previousKes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
              <div className="min-w-0 flex-1 basis-48">
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
              <div className="flex max-w-full flex-wrap items-center gap-3">
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
              className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 basis-40 wrap-anywhere">
                {row.name}
              </span>
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
    <div className="min-w-0">
      <Table aria-label="Recent payments">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Date</TableHead>
            <TableHead scope="col">Paid to</TableHead>
            <TableHead scope="col">How</TableHead>
            <TableHead scope="col" className="text-right">
              Amount
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{formatIsoDate(row.date)}</TableCell>
              <TableCell className="min-w-40 max-w-72 whitespace-normal wrap-anywhere">
                {row.name}
                <span className="block text-xs text-stone-500">
                  {row.categoryName}
                </span>
              </TableCell>
              <TableCell>{CHANNEL_LABELS[row.channel]}</TableCell>
              <TableCell className="text-right tabular-nums">
                {overviewKes(row.amountKes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
      <FieldGroup className="max-w-sm">
        <Field>
          <FieldLabel htmlFor="overview-person">Person</FieldLabel>
          <NativeSelect
            id="overview-person"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="">Choose a person</NativeSelectOption>
            {people.map((row) => (
              <NativeSelectOption key={row.id} value={row.id}>
                {row.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FieldGroup>
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
      <Alert variant="destructive" className="mt-4">
        <AlertDescription>{describeApiError(person.error)}</AlertDescription>
        <Button
          type="button"
          onClick={() => void person.refetch()}
          className="mt-2"
          variant="outline"
        >
          Try again
        </Button>
      </Alert>
    );
  }
  return <PersonFigures data={person.data} />;
}

function PersonFigures({ data }: { data: OverviewPerson }): JSX.Element {
  return (
    <div className="mt-4 grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-4">
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
      <div className="flex flex-col gap-4">
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
        <ul className="mt-1 flex flex-col gap-1 text-sm">{children}</ul>
      )}
    </div>
  );
}
