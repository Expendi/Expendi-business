"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FileCheckIcon,
  FileWarningIcon,
  FilterXIcon,
  ImageIcon,
  ImageOffIcon,
  MinusIcon,
  ReceiptTextIcon,
  TagIcon,
  TriangleAlertIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type {
  Expense,
  ExpenseListKind,
  ExpenseSortKey,
  ExpensesSummary,
} from "@expendi-business/shared";
import { ETIMS_STATUSES, EXPENSE_LIST_KINDS } from "@expendi-business/shared";

import type { ExpenseFilters } from "./expense-filters";
import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type { SortState } from "~/components/data/table";
import type { ExpenseListParams } from "~/lib/customer-api";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { AmountStack, Money } from "~/components/data/money";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsFoot,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
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
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { formatIsoDate } from "~/lib/dates";
import { queryKeys } from "~/lib/query-keys";
import {
  DEFAULT_SORT,
  filtersFromParams,
  filtersToParams,
  FIRST_DIRECTION,
  formatMonth,
  hasChipFilters,
  monthChoices,
  nairobiMonth,
  toApiQuery,
} from "./expense-filters";
import {
  ETIMS_LABELS,
  EXPENSE_STATUS,
  KIND_LABELS,
  KIND_TAB_LABELS,
  personName,
  STATUS_ORDER,
  WARNING_LABELS,
  warningCodes,
} from "./expense-labels";
import { ExpenseSheet } from "./expense-sheet";

export const EXPENSES_PAGE_SIZE = 50;
const RESULTS_ID = "expense-results";

type KindTabValue = ExpenseListKind | "all";

/**
 * Every expense (spec §6.14): reimbursements, petty cash and company
 * spending, money already spent, for admins and accountants alike. Bills
 * aren't here, not even company spending a bill recorded. Approving and
 * paying reimbursements happens in Approvals.
 */
export function ExpensesView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyExpenses
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyExpenses({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const { api } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = filtersFromParams(searchParams);
  const [openId, setOpenId] = useDeepLinkParam("expenseId");
  const [sort, setSort] = useState<SortState<ExpenseSortKey>>(DEFAULT_SORT);
  const apiQuery = toApiQuery(filters);

  const summary = useQuery({
    queryKey: queryKeys.expenseSummary(organizationId, apiQuery),
    queryFn: () => api.getExpensesSummary(organizationId, apiQuery),
    placeholderData: keepPreviousData,
  });
  const listQuery: ExpenseListParams = {
    ...apiQuery,
    sort: sort.key,
    dir: sort.dir,
    limit: EXPENSES_PAGE_SIZE,
  };
  const list = useInfiniteQuery({
    queryKey: queryKeys.expenseList(organizationId, listQuery),
    queryFn: ({ pageParam }) =>
      api.listExpenses(organizationId, {
        ...listQuery,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });

  function setFilters(next: ExpenseFilters) {
    const query = filtersToParams(next).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }
  const clearChips = () => setFilters({ kind: filters.kind });

  const rows = list.data?.pages.flatMap((page) => page.expenses) ?? [];
  const chipsSet = hasChipFilters(filters);

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Every reimbursement, petty cash purchase and company spending record, with its receipt. Months follow the purchase date."
        actions={
          canAct ? (
            <Button asChild variant="outline" size="md">
              <Link href="/imports?kind=history">
                <UploadIcon aria-hidden="true" />
                Import spreadsheet
              </Link>
            </Button>
          ) : null
        }
      />

      {list.isError && !list.data ? null : (
        <ExpenseStats summary={summary.data} month={filters.month} />
      )}

      <ResultsPanel label="Expenses">
        <ResultsHead
          stacked
          tabs={
            <KindTabs<KindTabValue>
              label="Kind"
              controls={RESULTS_ID}
              value={filters.kind ?? "all"}
              onChange={(kind) =>
                setFilters({
                  ...filters,
                  kind: kind === "all" ? undefined : kind,
                })
              }
              tabs={kindTabs(summary.data)}
            />
          }
          chips={
            <ExpenseChips
              organizationId={organizationId}
              filters={filters}
              onChange={setFilters}
            />
          }
          onClearAll={chipsSet ? clearChips : undefined}
        />
        <ChoicesError organizationId={organizationId} />
        <ResultsBody
          id={RESULTS_ID}
          busy={list.isPending}
          refreshing={list.isPlaceholderData}
        >
          {list.isPending ? (
            <table className="w-full border-separate border-spacing-0">
              <tbody>
                <TableSkeletonRows rows={6} columns={4} />
              </tbody>
            </table>
          ) : list.isError ? (
            <ErrorState
              title="Expenses didn't load"
              onRetry={() => void list.refetch()}
            >
              Check your connection, then try again.
            </ErrorState>
          ) : rows.length === 0 ? (
            <NoExpenses
              kind={filters.kind}
              chipsSet={chipsSet}
              canAct={canAct}
              onClearChips={clearChips}
              onShowAll={() => setFilters({ ...filters, kind: undefined })}
            />
          ) : (
            <>
              <ExpenseTable
                rows={rows}
                openId={openId}
                sort={sort}
                onSort={(key) =>
                  setSort(nextSort(sort, key, FIRST_DIRECTION[key]))
                }
                onOpen={setOpenId}
              />
              <ResultsFoot>
                <span className="tabular-nums">
                  Showing {rows.length}
                  {summary.data ? ` of ${String(summary.data.count)}` : ""}
                </span>
                {list.hasNextPage ? (
                  <Button
                    variant="outline"
                    size="md"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {list.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                ) : null}
              </ResultsFoot>
            </>
          )}
        </ResultsBody>
      </ResultsPanel>

      <ExpenseSheet
        organizationId={organizationId}
        openId={openId}
        rows={rows}
        onOpen={setOpenId}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

function kindTabs(
  summary: ExpensesSummary | undefined,
): KindTab<KindTabValue>[] {
  const kinds = summary?.kinds;
  return [
    {
      value: "all",
      label: "All",
      count: kinds ? kinds.claim + kinds.petty_cash + kinds.company : undefined,
    },
    ...EXPENSE_LIST_KINDS.map((kind) => ({
      value: kind,
      label: KIND_TAB_LABELS[kind],
      count: kinds?.[kind],
    })),
  ];
}

/** Numbers that describe what's in the table; filtering is in the chips. */
export function ExpenseStats({
  summary,
  month,
}: {
  summary: ExpensesSummary | undefined;
  month: string | undefined;
}): JSX.Element {
  if (!summary) {
    return (
      <StatCards>
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatCards>
    );
  }
  const scope = month ? formatMonth(month) : "All months";
  return (
    <StatCards>
      <StatCard
        icon={ReceiptTextIcon}
        tone="total"
        label="Total spent"
        value={<Money amount={summary.totalKes} currency="KES" />}
        sub={`${String(summary.count)} ${summary.count === 1 ? "expense" : "expenses"} · ${scope}`}
      />
      <AttentionStat
        label="Waiting for approval"
        icon={ClockIcon}
        totals={summary.waitingForApproval}
        tail="to approve"
      />
      <AttentionStat
        label="Without a receipt"
        icon={ImageOffIcon}
        totals={summary.withoutReceipt}
        tail="with no receipt"
      />
      <AttentionStat
        label="Without eTIMS"
        icon={FileWarningIcon}
        totals={summary.withoutEtims}
        tail="without an invoice"
      />
    </StatCards>
  );
}

function AttentionStat({
  label,
  icon,
  totals,
  tail,
}: {
  label: string;
  icon: LucideIcon;
  totals: ExpensesSummary["withoutReceipt"];
  tail: string;
}): JSX.Element {
  const any = totals.count > 0;
  return (
    <StatCard
      icon={any ? icon : CheckIcon}
      tone={any ? "attention" : "clear"}
      label={label}
      value={totals.count}
      sub={
        any ? (
          <>
            <Money amount={totals.totalKes} currency="KES" /> {tail}
          </>
        ) : (
          "All clear"
        )
      }
    />
  );
}

const RECEIPT_OPTIONS: readonly FilterOption[] = [
  { value: "0", label: "Has a receipt", icon: CheckIcon },
  { value: "1", label: "No receipt", icon: ImageOffIcon },
];

const ETIMS_ICONS = {
  attached: CheckIcon,
  not_required: MinusIcon,
  none: TriangleAlertIcon,
} as const;

const ETIMS_OPTIONS: readonly FilterOption[] = ETIMS_STATUSES.map((status) => ({
  value: status,
  label: ETIMS_LABELS[status],
  icon: ETIMS_ICONS[status],
}));

const STATUS_OPTIONS: readonly FilterOption[] = STATUS_ORDER.map((status) => ({
  value: status,
  label: EXPENSE_STATUS[status].label,
  tone: EXPENSE_STATUS[status].tone,
}));

function useFilterChoices(organizationId: string) {
  const { api } = useAuth();
  const members = useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
  });
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });
  return { members, categories };
}

/** Person, category, month, status, receipt and eTIMS, in the mock's order. */
function ExpenseChips({
  organizationId,
  filters,
  onChange,
}: {
  organizationId: string;
  filters: ExpenseFilters;
  onChange: (next: ExpenseFilters) => void;
}): JSX.Element {
  const { members, categories } = useFilterChoices(organizationId);
  const [thisMonth] = useState(() => nairobiMonth(new Date()));
  const set = (next: Partial<ExpenseFilters>) =>
    onChange({ ...filters, ...next });

  const people: FilterOption[] = (members.data ?? []).map((member) => ({
    value: member.id,
    label: personName(member),
    mark: "person",
  }));
  const categoryOptions: FilterOption[] = (categories.data ?? []).map(
    (category) => ({ value: category.id, label: category.name }),
  );
  const months: FilterOption[] = monthChoices(thisMonth, filters.month).map(
    (month) => ({ value: month, label: formatMonth(month) }),
  );

  return (
    <>
      <FilterChip
        label="Person"
        icon={UserIcon}
        options={people}
        value={filters.membershipId ?? null}
        onChange={(value) => set({ membershipId: value ?? undefined })}
        anyLabel="Everyone"
        searchPlaceholder="Search people"
        disabled={members.isError}
      />
      <FilterChip
        label="Category"
        icon={TagIcon}
        options={categoryOptions}
        value={filters.categoryId ?? null}
        onChange={(value) => set({ categoryId: value ?? undefined })}
        anyLabel="All categories"
        disabled={categories.isError}
      />
      <FilterChip
        label="Month"
        icon={CalendarIcon}
        options={months}
        value={filters.month ?? null}
        onChange={(value) => set({ month: value ?? undefined })}
        anyLabel="Any month"
      />
      <FilterChip
        label="Status"
        icon={ClockIcon}
        options={STATUS_OPTIONS}
        value={filters.status ?? null}
        onChange={(value) =>
          set({ status: STATUS_ORDER.find((status) => status === value) })
        }
        anyLabel="Any status"
      />
      <FilterChip
        label="Receipt"
        icon={ImageIcon}
        options={RECEIPT_OPTIONS}
        value={
          filters.noReceipt === undefined ? null : filters.noReceipt ? "1" : "0"
        }
        onChange={(value) =>
          set({ noReceipt: value === null ? undefined : value === "1" })
        }
        anyLabel="Any"
      />
      <FilterChip
        label="eTIMS"
        icon={FileCheckIcon}
        options={ETIMS_OPTIONS}
        value={filters.etimsStatus ?? null}
        onChange={(value) =>
          set({
            etimsStatus: ETIMS_STATUSES.find((status) => status === value),
          })
        }
        anyLabel="Any"
      />
    </>
  );
}

/** The person and category chips can't offer choices that didn't load. */
function ChoicesError({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element | null {
  const { members, categories } = useFilterChoices(organizationId);
  if (!members.isError && !categories.isError) return null;
  return (
    <p
      role="alert"
      className="flex items-center gap-1.5 border-b border-gray-200 bg-error-50 px-4 py-2 text-xs leading-4 text-error-700"
    >
      <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      Some filter choices couldn&apos;t load. Check your connection, then reload
      the page.
    </p>
  );
}

function NoExpenses({
  kind,
  chipsSet,
  canAct,
  onClearChips,
  onShowAll,
}: {
  kind: ExpenseListKind | undefined;
  chipsSet: boolean;
  canAct: boolean;
  onClearChips: () => void;
  onShowAll: () => void;
}): JSX.Element {
  if (chipsSet) {
    return (
      <EmptyState
        icon={FilterXIcon}
        title="No expenses match these filters"
        action={
          <Button variant="outline" size="md" onClick={onClearChips}>
            Clear filters
          </Button>
        }
      />
    );
  }
  if (kind) {
    return (
      <EmptyState
        icon={ReceiptTextIcon}
        title={`No ${KIND_TAB_LABELS[kind].toLowerCase()} yet`}
        action={
          <Button variant="outline" size="md" onClick={onShowAll}>
            See all expenses
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={ReceiptTextIcon}
      title="No expenses yet"
      action={
        canAct ? (
          <Button asChild variant="outline" size="md">
            <Link href="/imports?kind=history">Import spreadsheet</Link>
          </Button>
        ) : null
      }
    >
      Reimbursements, petty cash and company spending show up here.
    </EmptyState>
  );
}

/**
 * A row's markers: warnings, a missing receipt, and no eTIMS invoice
 * where the eTIMS column isn't showing (`collapsed`: only under a 900px
 * panel, where the column hides).
 */
function Flags({
  expense,
  etims,
}: {
  expense: Expense;
  etims: "always" | "collapsed";
}): JSX.Element {
  return (
    <>
      {warningCodes(expense.warnings).map((code) => (
        <Mini
          key={code}
          icon={TriangleAlertIcon}
          label={WARNING_LABELS[code]}
          warn
        >
          {WARNING_LABELS[code]}
        </Mini>
      ))}
      {expense.noReceipt ? (
        <Mini icon={ImageOffIcon} label="No receipt">
          No receipt
        </Mini>
      ) : null}
      {expense.etimsStatus === "none" ? (
        <span
          className={
            etims === "collapsed"
              ? "hidden @max-[900px]/results:inline-flex"
              : "inline-flex"
          }
        >
          <Mini icon={FileWarningIcon} label="No eTIMS invoice">
            No eTIMS
          </Mini>
        </span>
      ) : null}
    </>
  );
}

function EtimsCell({ expense }: { expense: Expense }): JSX.Element {
  if (expense.etimsStatus === "attached") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-gray-700">
        <CheckIcon aria-hidden="true" className="size-3.5 text-success-700" />
        Attached
      </span>
    );
  }
  if (expense.etimsStatus === "none") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-warn-700">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
        None
      </span>
    );
  }
  return <span className="whitespace-nowrap text-gray-500">Not required</span>;
}

/** One flat list, server-sorted; phone cards under a 720px panel. */
export function ExpenseTable({
  rows,
  openId,
  sort,
  onSort,
  onOpen,
}: {
  rows: readonly Expense[];
  openId: string | null;
  sort: SortState<ExpenseSortKey>;
  onSort: (key: ExpenseSortKey) => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <>
      <DataTable caption="Expenses">
        <thead>
          <tr>
            <SortHeader
              label="Date"
              sortKey="date"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Person"
              sortKey="person"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Expense"
              sortKey="merchant"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Amount"
              sortKey="amount"
              align="end"
              sort={sort}
              onSort={onSort}
            />
            <Th collapse="md">eTIMS</Th>
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((expense) => {
            const status = EXPENSE_STATUS[expense.status];
            const person = personName(expense.member);
            return (
              <DataRow
                key={expense.id}
                open={expense.id === openId}
                onOpen={() => onOpen(expense.id)}
              >
                <Td kind="date">{formatIsoDate(expense.spentOn)}</Td>
                <Td>
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <EntityMark name={person} kind="person" />
                    {person}
                  </span>
                </Td>
                <Td kind="main">
                  <RowTitle onOpen={() => onOpen(expense.id)}>
                    {expense.merchant}
                  </RowTitle>
                  <RowMeta
                    text={`${KIND_LABELS[expense.listKind]} · ${expense.category.name}`}
                  >
                    <Flags expense={expense} etims="collapsed" />
                  </RowMeta>
                </Td>
                <Td align="end">
                  <AmountStack>
                    <Money amount={expense.amountKes} currency="KES" />
                  </AmountStack>
                </Td>
                <Td collapse="md">
                  <EtimsCell expense={expense} />
                </Td>
                <Td>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Expenses">
        {rows.map((expense) => {
          const status = EXPENSE_STATUS[expense.status];
          const person = personName(expense.member);
          return (
            <PhoneCard
              key={expense.id}
              mark={<EntityMark name={person} kind="person" />}
              title={expense.merchant}
              sub={`${person} · ${formatIsoDate(expense.spentOn)}`}
              flags={
                <>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  <Flags expense={expense} etims="always" />
                </>
              }
              aside={
                <AmountStack>
                  <Money amount={expense.amountKes} currency="KES" />
                </AmountStack>
              }
              onOpen={() => onOpen(expense.id)}
            />
          );
        })}
      </PhoneCards>
    </>
  );
}
