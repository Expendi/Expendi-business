"use client";

import type { FormEvent, JSX } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { Expense } from "@expendi-business/shared";
import { ETIMS_STATUSES, EXPENSE_LIST_KINDS } from "@expendi-business/shared";

import type { ExpenseFilters } from "./expense-filters";
import {
  ETIMS_STATUS_LABELS,
  EXPENSE_LIST_KIND_LABELS,
  ExpenseStatusBadge,
  WarningBadges,
} from "~/components/expense-status";
import {
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";
import { ExpenseDetailPanel } from "./expense-detail";
import {
  filtersFromForm,
  filtersFromParams,
  filtersToParams,
} from "./expense-filters";

const PAGE_SIZE = 50;

/**
 * All expenses (spec §6.14): claims, petty cash and company spending, for
 * admins and accountants alike. Read-only: approving and paying claims is
 * on Approvals.
 */
export function ExpensesView(): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { company, canAct } = useDashboard();
  const filters = filtersFromParams(searchParams);
  const filtersKey = filtersToParams(filters).toString();

  function onFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = filtersToParams(
      filtersFromForm(new FormData(event.currentTarget)),
    ).toString();
    router.push(params ? `${pathname}?${params}` : pathname);
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">Expenses</h1>
      <p className="mt-1 text-sm text-stone-600">
        Every claim, petty cash purchase and company spending record, with its
        receipt. Months follow the purchase date.
      </p>
      {canAct ? (
        <Link
          href="/imports?kind=history"
          className={`${secondaryButton} mt-4`}
        >
          Import spreadsheet
        </Link>
      ) : null}

      <ExpenseFilterForm
        key={`${company.organizationId}?${filtersKey}`}
        organizationId={company.organizationId}
        filters={filters}
        onSubmit={onFilter}
        onClear={() => router.push(pathname)}
      />

      <ExpenseResults
        key={`${company.organizationId}?${filtersKey}`}
        organizationId={company.organizationId}
        filters={filters}
      />
    </section>
  );
}

function ExpenseFilterForm({
  organizationId,
  filters,
  onSubmit,
  onClear,
}: {
  organizationId: string;
  filters: ExpenseFilters;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const members = useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
  });
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Filter expenses"
      className="mt-6 grid grid-cols-1 gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      <label className="text-sm">
        Person
        <select
          name="membershipId"
          defaultValue={filters.membershipId ?? ""}
          className={inputClass}
        >
          <option value="">Everyone</option>
          {members.data?.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name ?? member.email}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Kind
        <select
          name="kind"
          defaultValue={filters.kind ?? ""}
          className={inputClass}
        >
          <option value="">All kinds</option>
          {EXPENSE_LIST_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {EXPENSE_LIST_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Category
        <select
          name="categoryId"
          defaultValue={filters.categoryId ?? ""}
          className={inputClass}
        >
          <option value="">All categories</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Month
        <input
          type="month"
          name="month"
          defaultValue={filters.month ?? ""}
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        eTIMS
        <select
          name="etimsStatus"
          defaultValue={filters.etimsStatus ?? ""}
          className={inputClass}
        >
          <option value="">Any</option>
          {ETIMS_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ETIMS_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      {members.isError || categories.isError ? (
        <p className="text-sm text-error-700 sm:col-span-2 lg:col-span-5">
          Some filter choices couldn&apos;t load.{" "}
          {describeApiError(members.error ?? categories.error)}
        </p>
      ) : null}
      <div className="flex gap-3 sm:col-span-2 lg:col-span-5">
        <button type="submit" className={primaryButton}>
          Filter
        </button>
        <button type="button" onClick={onClear} className={secondaryButton}>
          Clear
        </button>
      </div>
    </form>
  );
}

function personOf(expense: Expense): string {
  return expense.member.name ?? expense.member.email;
}

/** Keyed on the company and filters, so a new search starts at the latest page. */
function ExpenseResults({
  organizationId,
  filters,
}: {
  organizationId: string;
  filters: ExpenseFilters;
}): JSX.Element {
  const { api } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = { ...filters, limit: PAGE_SIZE };
  const result = useInfiniteQuery({
    queryKey: queryKeys.expenseList(organizationId, query),
    queryFn: ({ pageParam }) =>
      api.listExpenses(organizationId, {
        ...query,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  if (result.isPending) {
    return <p className="mt-6 text-sm text-stone-500">Loading expenses…</p>;
  }
  if (result.isError) {
    return (
      <div className="mt-6 text-sm text-error-700" role="alert">
        <p>{describeApiError(result.error)}</p>
        <button
          type="button"
          onClick={() => void result.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }

  const expenses = result.data.pages.flatMap((page) => page.expenses);
  if (expenses.length === 0) {
    return (
      <p className="mt-6 rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        No expenses match these filters.
      </p>
    );
  }

  return (
    <div
      className={`mt-6 grid gap-6 ${selectedId ? "xl:grid-cols-2" : ""} xl:items-start`}
    >
      <div>
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className={tableClass}>
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th scope="col" className={headCellClass}>
                  Date
                </th>
                <th scope="col" className={headCellClass}>
                  Expense
                </th>
                <th scope="col" className={headCellClass}>
                  Person
                </th>
                <th scope="col" className={`${headCellClass} text-right`}>
                  KES
                </th>
                <th scope="col" className={headCellClass}>
                  eTIMS
                </th>
                <th scope="col" className={headCellClass}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr
                  key={expense.id}
                  className={`border-t border-stone-200 align-top ${expense.id === selectedId ? "bg-brand-50" : ""}`}
                >
                  <td className={`${cellClass} whitespace-nowrap`}>
                    {formatIsoDate(expense.spentOn)}
                  </td>
                  <td className={cellClass}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(expense.id)}
                      aria-pressed={expense.id === selectedId}
                      className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
                    >
                      {expense.merchant}
                    </button>
                    <span className="block text-xs text-stone-500">
                      {EXPENSE_LIST_KIND_LABELS[expense.listKind]} ·{" "}
                      {expense.category.name}
                      {expense.noReceipt ? " · No receipt" : ""}
                    </span>
                    <WarningBadges warnings={expense.warnings} />
                  </td>
                  <td className={cellClass}>{personOf(expense)}</td>
                  <td
                    className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
                  >
                    {formatKesCents(expense.amountKes)}
                  </td>
                  <td className={cellClass}>
                    {ETIMS_STATUS_LABELS[expense.etimsStatus]}
                  </td>
                  <td className={cellClass}>
                    <ExpenseStatusBadge status={expense.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.hasNextPage ? (
          <button
            type="button"
            onClick={() => void result.fetchNextPage()}
            disabled={result.isFetchingNextPage}
            className={`mt-4 ${secondaryButton}`}
          >
            {result.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
      {selectedId ? (
        <div className="xl:sticky xl:top-8">
          <ExpenseDetailPanel
            key={selectedId}
            organizationId={organizationId}
            expenseId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
