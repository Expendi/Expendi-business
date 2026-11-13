"use client";

import type { JSX } from "react";
import {
  Building2Icon,
  CircleCheckIcon,
  ClockIcon,
  FilterXIcon,
  LayersIcon,
  RepeatIcon,
  TagIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo } from "react";

import type {
  Bill,
  BillListView,
  BillsSummary,
  Category,
  Payee,
} from "@expendi-business/shared";
import {
  BILL_HEADINGS,
  BILL_METHOD_FILTERS,
  BILL_PAYMENT_MAX_BILLS,
} from "@expendi-business/shared";

import type { BillSelection } from "./columns";
import type { DataTableRow } from "~/components/data/data-table";
import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type {
  BillFilters,
  BillSort,
  BillSortKey,
} from "~/features/bills/bill-list";
import { TextLinkButton } from "~/components/data/actions";
import { EntityMark, PhoneCard } from "~/components/data/cells";
import {
  DataTable,
  DataTablePagination,
  DataTableToolbar,
  useDataTable,
} from "~/components/data/data-table";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { KesTotal } from "~/components/data/money";
import { ResultsBody, ResultsPanel } from "~/components/data/results";
import { SelectionBar } from "~/components/data/selection-bar";
import { EmptyState, ErrorState } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { storedAmount } from "~/features/bills/bill-amount";
import { anyFilterSet, rowDate, statusesOf } from "~/features/bills/bill-list";
import {
  BILL_STATUSES,
  BillAmount,
  BillStatusBadge,
  CardBillBadge,
  HEADING_LABELS,
} from "~/features/bills/bill-status";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { formatIsoDate } from "~/lib/dates";
import { approxKesTotal, totalsByCurrency } from "~/lib/money";
import {
  BillCheckbox,
  billColumns,
  canSelect,
  isBillSortKey,
  Markers,
} from "./columns";

const VIEW_LABELS: Readonly<Record<BillListView, string>> = {
  open: "To pay",
  paying: "Being paid",
  history: "History",
};

const CAPTIONS: Readonly<Record<BillListView, string>> = {
  open: "Bills to pay",
  paying: "Bills being paid",
  history: "Bills paid or cancelled",
};

const EMPTY: Readonly<Record<BillListView, { title: string; text: string }>> = {
  open: {
    title: "Nothing to pay",
    text: "New bills and recurring payments show up here.",
  },
  paying: {
    title: "Nothing being paid",
    text: "Bills you pay stay here until the payee receives the money.",
  },
  history: {
    title: "Nothing settled yet",
    text: "No bills paid or cancelled in the last six months.",
  },
};

const METHOD_OPTIONS: readonly FilterOption[] = BILL_METHOD_FILTERS.map(
  (method) => ({
    value: method,
    label: method === "none" ? "Not set" : METHOD_LABELS[method],
  }),
);

const HEADING_OPTIONS: readonly FilterOption[] = BILL_HEADINGS.map(
  (heading) => ({ value: heading, label: HEADING_LABELS[heading] }),
);

const SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: "recurring", label: "Recurring" },
  { value: "one_off", label: "One-off" },
];

/**
 * The tabs and filter chips, then one flat sortable list of bills (phone
 * cards in a narrow panel), and while bills can be paid together, the
 * selection bar.
 */
export function BillsResults({
  view,
  onView,
  counts,
  filters,
  onFilter,
  onClearAll,
  payees,
  categories,
  rows,
  loading,
  failed,
  refreshing,
  onRetry,
  sort,
  onSort,
  rate,
  today,
  openId,
  onOpen,
  selection,
}: {
  view: BillListView;
  onView: (view: BillListView) => void;
  /** Left out while the summary loads. */
  counts: BillsSummary["views"] | undefined;
  filters: BillFilters;
  onFilter: (name: keyof BillFilters, value: string | null) => void;
  onClearAll: () => void;
  payees: readonly Payee[];
  categories: readonly Category[];
  rows: readonly Bill[];
  loading: boolean;
  failed: boolean;
  refreshing: boolean;
  onRetry: () => void;
  sort: BillSort;
  onSort: (key: BillSortKey) => void;
  rate: string | null;
  today: string;
  openId: string | null;
  onOpen: (billId: string) => void;
  /** Only an admin with a passkey, on To pay. */
  selection: BillSelection | null;
}): JSX.Element {
  const tabs: readonly KindTab<BillListView>[] = (
    ["open", "paying", "history"] as const
  ).map((value) => ({
    value,
    label: VIEW_LABELS[value],
    count: counts?.[value],
  }));
  const statusOptions: readonly FilterOption[] = statusesOf(view).map(
    (status) => ({
      value: status,
      label: BILL_STATUSES[status].label,
      tone: BILL_STATUSES[status].tone,
    }),
  );
  const payeeOptions: readonly FilterOption[] = payees
    .filter((payee) => payee.billCount === undefined || payee.billCount > 0)
    .map((payee) => ({ value: payee.id, label: payee.name, mark: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const categoryOptions: readonly FilterOption[] = categories.map(
    (category) => ({ value: category.id, label: category.name }),
  );
  const filtered = anyFilterSet(filters);
  const settled = view === "history";

  const columns = useMemo(
    () => billColumns({ view, rate, today, selection, onOpen }),
    [view, rate, today, selection, onOpen],
  );
  const selectedRows = useMemo(() => {
    const ticked: Record<string, true> = {};
    for (const billId of selection?.selected ?? []) ticked[billId] = true;
    return ticked;
  }, [selection?.selected]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (bill) => bill.id,
    manual: { sorting: true, filtering: true },
    sorting: {
      value: [{ id: sort.key, desc: sort.dir === "desc" }],
      onChange: ([next]) => {
        if (next && isBillSortKey(next.id)) onSort(next.id);
      },
    },
    rowSelection: { value: selectedRows },
  });

  return (
    <ResultsPanel label="Bills">
      <div className="overflow-x-auto border-b border-border px-4 py-3">
        <KindTabs
          label="Bills"
          tabs={tabs}
          value={view}
          onChange={onView}
          controls="bills-results"
        />
      </div>
      <DataTableToolbar
        table={table}
        actions={
          filtered ? (
            <TextLinkButton onClick={onClearAll}>Clear all</TextLinkButton>
          ) : null
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1">
          {view === "paying" ? null : (
            <FilterChip
              label="Status"
              icon={ClockIcon}
              options={statusOptions}
              value={filters.status}
              onChange={(value) => onFilter("status", value)}
              anyLabel="Any status"
            />
          )}
          <FilterChip
            label="Payee"
            icon={Building2Icon}
            options={payeeOptions}
            value={filters.payeeId}
            onChange={(value) => onFilter("payeeId", value)}
            anyLabel="Every payee"
            searchPlaceholder="Search payees"
          />
          <FilterChip
            label="Category"
            icon={TagIcon}
            options={categoryOptions}
            value={filters.categoryId}
            onChange={(value) => onFilter("categoryId", value)}
            anyLabel="All categories"
          />
          <FilterChip
            label="Heading"
            icon={LayersIcon}
            options={HEADING_OPTIONS}
            value={filters.heading}
            onChange={(value) => onFilter("heading", value)}
            anyLabel="Every heading"
          />
          <FilterChip
            label="Paid by"
            icon={WalletIcon}
            options={METHOD_OPTIONS}
            value={filters.method}
            onChange={(value) => onFilter("method", value)}
            anyLabel="Any method"
          />
          <FilterChip
            label="Source"
            icon={RepeatIcon}
            options={SOURCE_OPTIONS}
            value={filters.source}
            onChange={(value) => onFilter("source", value)}
            anyLabel="Any source"
          />
        </div>
      </DataTableToolbar>
      <ResultsBody id="bills-results" busy={loading} refreshing={refreshing}>
        {failed ? (
          <ErrorState title="Bills didn't load" onRetry={onRetry} />
        ) : !loading && rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={FilterXIcon}
              title="No bills match these filters"
              action={
                <Button variant="outline" size="md" onClick={onClearAll}>
                  Clear all
                </Button>
              }
            />
          ) : (
            <EmptyState icon={CircleCheckIcon} title={EMPTY[view].title}>
              {EMPTY[view].text}
            </EmptyState>
          )
        ) : (
          <DataTable
            table={table}
            caption={loading ? "Loading bills" : CAPTIONS[view]}
            phoneLabel={loading ? "Loading bills" : "Bills"}
            loading={loading}
            onRowOpen={(bill) => onOpen(bill.id)}
            openRowId={openId}
            renderPhoneCard={(row) => (
              <BillPhoneCard
                key={row.id}
                row={row}
                settled={settled}
                view={view}
                rate={rate}
                selection={selection}
                onOpen={onOpen}
              />
            )}
          />
        )}
        {selection && !loading && !failed && rows.length > 0 ? (
          <PayBar rows={rows} selection={selection} rate={rate} />
        ) : null}
      </ResultsBody>
      {loading || failed || rows.length === 0 ? null : (
        <DataTablePagination table={table} noun="bills" />
      )}
    </ResultsPanel>
  );
}

function BillPhoneCard({
  row,
  settled,
  view,
  rate,
  selection,
  onOpen,
}: {
  row: DataTableRow<Bill>;
  settled: boolean;
  view: BillListView;
  rate: string | null;
  selection: BillSelection | null;
  onOpen: (billId: string) => void;
}): JSX.Element {
  const bill = row.original;
  return (
    <PhoneCard
      mark={<EntityMark name={bill.payee.name} />}
      title={bill.payee.name}
      sub={`${settled ? "Settled" : "Due"} ${formatIsoDate(rowDate(bill, view))}`}
      flags={
        <>
          <BillStatusBadge status={bill.status} />
          <CardBillBadge bill={bill} />
          <Markers bill={bill} />
        </>
      }
      aside={<BillAmount bill={bill} rate={rate} />}
      onOpen={() => onOpen(bill.id)}
      check={
        selection ? (
          canSelect(bill) ? (
            <BillCheckbox bill={bill} selection={selection} />
          ) : (
            <span aria-hidden="true" />
          )
        ) : null
      }
      selected={row.getIsSelected()}
    />
  );
}

/** Pay all: the selection and its one KES total, "Select all payable" and Pay. */
function PayBar({
  rows,
  selection,
  rate,
}: {
  rows: readonly Bill[];
  selection: BillSelection;
  rate: string | null;
}): JSX.Element {
  const chosen = rows.filter((bill) => selection.selected.includes(bill.id));
  const payable = rows.filter(canSelect);
  const remaining = payable.filter(
    (bill) => !selection.selected.includes(bill.id),
  );
  const total = approxKesTotal({
    ...totalsByCurrency(
      chosen.map((bill) => ({
        currency: bill.currency,
        amount: storedAmount(bill),
      })),
    ),
    rate,
  });
  return (
    <SelectionBar
      summary={
        chosen.length === 0 ? (
          "Select bills to pay together."
        ) : (
          <>
            <strong className="tabular-nums">{chosen.length} selected</strong>
            {" · "}
            <KesTotal total={total} />
          </>
        )
      }
      links={
        <>
          {remaining.length > 0 &&
          selection.selected.length < BILL_PAYMENT_MAX_BILLS ? (
            <TextLinkButton
              disabled={selection.busy}
              onClick={() =>
                selection.onSelect(
                  payable
                    .slice(0, BILL_PAYMENT_MAX_BILLS)
                    .map((bill) => bill.id),
                )
              }
            >
              Select all payable
              {payable.length > BILL_PAYMENT_MAX_BILLS
                ? ` (first ${String(BILL_PAYMENT_MAX_BILLS)})`
                : ""}
            </TextLinkButton>
          ) : null}
          {chosen.length > 0 ? (
            <TextLinkButton
              disabled={selection.busy}
              onClick={() => selection.onSelect([])}
            >
              Clear selection
            </TextLinkButton>
          ) : null}
        </>
      }
      action={
        <Button
          disabled={chosen.length === 0 || selection.busy}
          onClick={selection.onPay}
        >
          {selection.preparing
            ? "Working out the cost…"
            : chosen.length > 1
              ? `Pay all ${String(chosen.length)}`
              : "Pay"}
        </Button>
      }
    />
  );
}
