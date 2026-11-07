"use client";

import type { JSX } from "react";
import {
  Building2Icon,
  CircleCheckIcon,
  ClockIcon,
  FilterXIcon,
  LayersIcon,
  PaperclipIcon,
  RepeatIcon,
  TagIcon,
  WalletIcon,
} from "lucide-react";

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

import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type {
  BillFilters,
  BillSort,
  BillSortKey,
} from "~/features/bills/bill-list";
import { TextLinkButton } from "~/components/data/actions";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { KesTotal } from "~/components/data/money";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import { SelectionBar } from "~/components/data/selection-bar";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
  PhoneCard,
  PhoneCards,
  RowCheckbox,
  RowMeta,
  RowTitle,
  SortHeader,
  TableSkeletonRows,
  Td,
  Th,
} from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { storedAmount } from "~/features/bills/bill-amount";
import {
  anyFilterSet,
  dueHint,
  rowDate,
  statusesOf,
} from "~/features/bills/bill-list";
import { isPayable } from "~/features/bills/bill-payment";
import {
  BILL_STATUSES,
  BillAmount,
  BillStatusBadge,
  HEADING_LABELS,
} from "~/features/bills/bill-status";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { formatIsoDate } from "~/lib/dates";
import { approxKesTotal, totalsByCurrency } from "~/lib/money";

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

/** Selected together for Pay all; a failed payment is retried on its own. */
export const canSelect = (bill: Bill): boolean =>
  isPayable(bill) && bill.status !== "payout_failed";

export interface BillSelection {
  readonly selected: readonly string[];
  /** A payment is being prepared or reviewed. */
  readonly busy: boolean;
  readonly preparing: boolean;
  readonly onToggle: (billId: string) => void;
  readonly onSelect: (billIds: string[]) => void;
  readonly onPay: () => void;
}

/** "In 3 days" under a due date: red when late, amber today. */
function DueHintLine({
  bill,
  today,
}: {
  bill: Bill;
  today: string;
}): JSX.Element | null {
  const hint = dueHint(bill, today);
  if (!hint) return null;
  const tone =
    hint.tone === "late"
      ? "font-(--w-ui) text-error-700"
      : hint.tone === "today"
        ? "font-(--w-ui) text-warn-700"
        : "text-gray-500";
  return (
    <span className={`mt-0.5 block text-xs leading-4 ${tone}`}>
      {hint.text}
    </span>
  );
}

function Markers({ bill }: { bill: Bill }): JSX.Element {
  const files = bill.fileCount;
  return (
    <>
      {bill.recurringItemId ? (
        <Mini icon={RepeatIcon} label="Recurring" />
      ) : null}
      {files > 0 ? (
        <Mini
          icon={PaperclipIcon}
          label={`${String(files)} ${files === 1 ? "file" : "files"}`}
        >
          {files}
        </Mini>
      ) : null}
    </>
  );
}

const metaOf = (bill: Bill): string =>
  [bill.reference, bill.category.name].filter(Boolean).join(" · ");

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

  return (
    <ResultsPanel label="Bills">
      <ResultsHead
        tabs={
          <KindTabs
            label="Bills"
            tabs={tabs}
            value={view}
            onChange={onView}
            controls="bills-results"
          />
        }
        chips={
          <>
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
          </>
        }
        onClearAll={filtered ? onClearAll : undefined}
      />
      <ResultsBody id="bills-results" busy={loading} refreshing={refreshing}>
        {loading ? (
          <LoadingRows />
        ) : failed ? (
          <ErrorState title="Bills didn't load" onRetry={onRetry} />
        ) : rows.length === 0 ? (
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
          <BillRows
            view={view}
            rows={rows}
            sort={sort}
            onSort={onSort}
            rate={rate}
            today={today}
            openId={openId}
            onOpen={onOpen}
            selection={selection}
          />
        )}
        {selection && !loading && !failed && rows.length > 0 ? (
          <PayBar rows={rows} selection={selection} rate={rate} />
        ) : null}
      </ResultsBody>
    </ResultsPanel>
  );
}

function LoadingRows(): JSX.Element {
  return (
    <>
      <DataTable caption="Loading bills">
        <tbody>
          <TableSkeletonRows rows={6} columns={4} />
        </tbody>
      </DataTable>
      <PhoneCards label="Loading bills">
        {[0, 1, 2, 3].map((row) => (
          <li
            key={row}
            aria-hidden="true"
            className="flex items-start gap-3 border-b border-row-divider px-4 py-3.5"
          >
            <Skel width={32} height={32} />
            <div className="flex-1">
              <Skel width="55%" height={14} />
              <Skel width="35%" height={12} style={{ marginTop: 8 }} />
            </div>
          </li>
        ))}
      </PhoneCards>
    </>
  );
}

function BillRows({
  view,
  rows,
  sort,
  onSort,
  rate,
  today,
  openId,
  onOpen,
  selection,
}: {
  view: BillListView;
  rows: readonly Bill[];
  sort: BillSort;
  onSort: (key: BillSortKey) => void;
  rate: string | null;
  today: string;
  openId: string | null;
  onOpen: (billId: string) => void;
  selection: BillSelection | null;
}): JSX.Element {
  const settled = view === "history";

  function checkbox(bill: Bill) {
    if (!selection || !canSelect(bill)) return null;
    const checked = selection.selected.includes(bill.id);
    const atLimit =
      !checked && selection.selected.length >= BILL_PAYMENT_MAX_BILLS;
    return (
      <RowCheckbox
        aria-label={`Select ${bill.payee.name}`}
        checked={checked}
        disabled={selection.busy || atLimit}
        title={
          atLimit
            ? `Pay up to ${String(BILL_PAYMENT_MAX_BILLS)} bills at a time.`
            : undefined
        }
        onChange={() => selection.onToggle(bill.id)}
      />
    );
  }

  return (
    <>
      <DataTable caption={CAPTIONS[view]}>
        <thead>
          <tr>
            {selection ? (
              <Th checkbox>
                <span className="sr-only">Select</span>
              </Th>
            ) : null}
            <SortHeader
              label={settled ? "Settled" : "Due"}
              sortKey="date"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Payee"
              sortKey="payee"
              sort={sort}
              onSort={onSort}
            />
            <Th collapse="lg">Paid by</Th>
            <SortHeader
              label="Amount"
              sortKey="amount"
              align="end"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((bill) => (
            <DataRow
              key={bill.id}
              open={bill.id === openId}
              selected={selection?.selected.includes(bill.id) ?? false}
              onOpen={() => onOpen(bill.id)}
            >
              {selection ? <Td kind="checkbox">{checkbox(bill)}</Td> : null}
              <Td kind="date">
                {formatIsoDate(rowDate(bill, view))}
                {settled ? null : <DueHintLine bill={bill} today={today} />}
              </Td>
              <Td kind="main">
                <span className="flex min-w-0 items-start gap-3">
                  <EntityMark name={bill.payee.name} />
                  <span className="min-w-0">
                    <RowTitle onOpen={() => onOpen(bill.id)}>
                      {bill.payee.name}
                    </RowTitle>
                    <RowMeta text={metaOf(bill)}>
                      <Markers bill={bill} />
                    </RowMeta>
                  </span>
                </span>
              </Td>
              <Td
                collapse="lg"
                className={
                  bill.payee.method
                    ? "whitespace-nowrap text-gray-600"
                    : "whitespace-nowrap text-gray-500"
                }
              >
                {bill.payee.method
                  ? METHOD_LABELS[bill.payee.method]
                  : "Not set"}
              </Td>
              <Td align="end">
                <BillAmount bill={bill} rate={rate} />
              </Td>
              <Td>
                <BillStatusBadge status={bill.status} />
              </Td>
            </DataRow>
          ))}
        </tbody>
      </DataTable>
      <PhoneCards label="Bills">
        {rows.map((bill) => (
          <PhoneCard
            key={bill.id}
            mark={<EntityMark name={bill.payee.name} />}
            title={bill.payee.name}
            sub={`${settled ? "Settled" : "Due"} ${formatIsoDate(rowDate(bill, view))}`}
            flags={
              <>
                <BillStatusBadge status={bill.status} />
                <Markers bill={bill} />
              </>
            }
            aside={<BillAmount bill={bill} rate={rate} />}
            onOpen={() => onOpen(bill.id)}
            check={
              selection ? (checkbox(bill) ?? <span aria-hidden="true" />) : null
            }
            selected={selection?.selected.includes(bill.id) ?? false}
          />
        ))}
      </PhoneCards>
    </>
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
