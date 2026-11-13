import type { JSX } from "react";
import { PaperclipIcon, RepeatIcon } from "lucide-react";

import type { Bill, BillListView } from "@expendi-business/shared";
import { BILL_PAYMENT_MAX_BILLS } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import type { BillSortKey } from "~/features/bills/bill-list";
import {
  EntityMark,
  Mini,
  RowCheckbox,
  RowMeta,
  RowTitle,
} from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { storedAmount } from "~/features/bills/bill-amount";
import { dueHint, rowDate } from "~/features/bills/bill-list";
import { isPayable } from "~/features/bills/bill-payment";
import {
  BillAmount,
  BillStatusBadge,
  CardBillBadge,
  lastFourOf,
} from "~/features/bills/bill-status";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { formatIsoDate } from "~/lib/dates";

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

const SORT_KEYS: readonly BillSortKey[] = ["date", "payee", "amount", "status"];

export const isBillSortKey = (id: string): id is BillSortKey =>
  SORT_KEYS.some((key) => key === id);

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
      ? "font-(--w-ui) text-destructive"
      : hint.tone === "today"
        ? "font-(--w-ui) text-warn-700"
        : "text-muted-foreground";
  return (
    <span className={`mt-0.5 block text-xs leading-4 ${tone}`}>
      {hint.text}
    </span>
  );
}

export function Markers({ bill }: { bill: Bill }): JSX.Element {
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

export const metaOf = (bill: Bill): string =>
  [bill.reference, bill.category.name].filter(Boolean).join(" · ");

/** How it's paid: the company-held card for a bill a card pays, the payee's method otherwise. */
export function paidByText(bill: Bill): string {
  if (bill.card) return `Company-held card ${lastFourOf(bill.card)}`;
  return bill.payee.method ? METHOD_LABELS[bill.payee.method] : "Not set";
}

/** The status, then whether a company-held card pays it or declined it. */
export function BillStatusCell({ bill }: { bill: Bill }): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <BillStatusBadge status={bill.status} />
      <CardBillBadge bill={bill} />
    </span>
  );
}

export function BillCheckbox({
  bill,
  selection,
}: {
  bill: Bill;
  selection: BillSelection | null;
}): JSX.Element | null {
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

export function billColumns({
  view,
  rate,
  today,
  selection,
  onOpen,
}: {
  view: BillListView;
  rate: string | null;
  today: string;
  selection: BillSelection | null;
  onOpen: (billId: string) => void;
}): DataTableColumnDef<Bill>[] {
  const settled = view === "history";
  const dateLabel = settled ? "Settled" : "Due";
  const columns: DataTableColumnDef<Bill>[] = [
    {
      id: "date",
      accessorFn: (bill) => rowDate(bill, view),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title={dateLabel} />
      ),
      cell: ({ row }) => (
        <>
          {formatIsoDate(rowDate(row.original, view))}
          {settled ? null : <DueHintLine bill={row.original} today={today} />}
        </>
      ),
      meta: { kind: "date", label: dateLabel },
    },
    {
      id: "payee",
      accessorFn: (bill) => bill.payee.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Payee" />
      ),
      cell: ({ row }) => (
        <span className="flex min-w-0 items-start gap-3">
          <EntityMark name={row.original.payee.name} />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original.id)}>
              {row.original.payee.name}
            </RowTitle>
            <RowMeta text={metaOf(row.original)}>
              <Markers bill={row.original} />
            </RowMeta>
          </span>
        </span>
      ),
      enableHiding: false,
      meta: { kind: "main", label: "Payee" },
    },
    {
      id: "method",
      accessorFn: (bill) => bill.payee.method ?? "",
      header: "Paid by",
      cell: ({ row }) => paidByText(row.original),
      enableSorting: false,
      meta: {
        collapse: "lg",
        label: "Paid by",
        className: "whitespace-nowrap text-muted-foreground",
      },
    },
    {
      id: "amount",
      accessorFn: (bill) => storedAmount(bill) ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => <BillAmount bill={row.original} rate={rate} />,
      meta: { align: "end", label: "Amount" },
    },
    {
      id: "status",
      accessorFn: (bill) => bill.status,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => <BillStatusCell bill={row.original} />,
      meta: { label: "Status" },
    },
  ];
  if (!selection) return columns;
  return [
    {
      id: "select",
      header: () => <span className="sr-only">Select</span>,
      cell: ({ row }) => (
        <BillCheckbox bill={row.original} selection={selection} />
      ),
      enableSorting: false,
      enableHiding: false,
      meta: { kind: "checkbox" },
    },
    ...columns,
  ];
}
