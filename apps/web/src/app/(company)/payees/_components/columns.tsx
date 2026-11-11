import type { JSX } from "react";
import { ShieldAlertIcon } from "lucide-react";

import type { Payee } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import type { PayeeSortKey } from "~/features/payees/payee-display";
import {
  EntityMark,
  Mini,
  PhoneCard,
  RowMeta,
  RowTitle,
} from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { StatusBadge } from "~/components/data/status-badge";
import {
  detailSummary,
  formatNairobiTime,
  isPerson,
  KIND_LABELS,
  METHOD_LABELS,
  PAYEE_SORT_FIRST,
  payeeMetaLine,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import { formatNairobiDate } from "~/lib/dates";
import { formatNairobiDateTime } from "~/lib/nairobi-time";

interface PayeeColumnOptions {
  readonly onOpen: (payee: Payee) => void;
  readonly bankName: (payee: Payee) => string | null;
}

function sortOptions(key: PayeeSortKey) {
  return {
    sortDescFirst: PAYEE_SORT_FIRST[key] === "desc",
    enableSortingRemoval: false,
  } as const;
}

function summaryOf(
  payee: Payee,
  bankName: PayeeColumnOptions["bankName"],
): string | null {
  return payee.details
    ? detailSummary(payee.details, payee.payoutPhoneConfirmed, bankName(payee))
    : null;
}

export function payeeColumns({
  onOpen,
  bankName,
}: PayeeColumnOptions): DataTableColumnDef<Payee>[] {
  return [
    {
      id: "name",
      accessorFn: (payee) => payee.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Name" />
      ),
      cell: ({ row }) => {
        const payee = row.original;
        return (
          <span className="flex min-w-0 items-start gap-3">
            <EntityMark
              name={payee.name}
              kind={isPerson(payee) ? "person" : "business"}
            />
            <span className="min-w-0">
              <RowTitle onOpen={() => onOpen(payee)}>{payee.name}</RowTitle>
              <RowMeta text={payeeMetaLine(payee)}>
                {payee.secondConfirmationUntil ? (
                  <Mini
                    icon={ShieldAlertIcon}
                    warn
                    label={`Paying them before ${formatNairobiDateTime(payee.secondConfirmationUntil)} needs a second confirmation.`}
                  >
                    {RECENTLY_CHANGED_LABEL}
                  </Mini>
                ) : null}
              </RowMeta>
            </span>
          </span>
        );
      },
      meta: { kind: "main", label: "Name" },
      enableHiding: false,
      ...sortOptions("name"),
    },
    {
      id: "method",
      accessorFn: (payee) => payee.details?.method ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Paid by" />
      ),
      cell: ({ row }) => {
        const payee = row.original;
        const sub = summaryOf(payee, bankName);
        return payee.details ? (
          <>
            <span className="block leading-6 text-muted-foreground">
              {METHOD_LABELS[payee.details.method]}
            </span>
            {sub ? (
              <span
                title={sub}
                className="block max-w-[300px] truncate text-muted-foreground tabular-nums"
              >
                {sub}
              </span>
            ) : null}
          </>
        ) : (
          <span className="block leading-6 text-muted-foreground">
            No payment details yet
          </span>
        );
      },
      meta: { label: "Paid by", className: "whitespace-nowrap" },
      ...sortOptions("method"),
    },
    {
      id: "changed",
      accessorFn: (payee) => payee.detailsChangedAt ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Details changed" />
      ),
      cell: ({ row }) =>
        row.original.detailsChangedAt ? (
          <>
            <span className="block leading-6">
              {formatNairobiDate(row.original.detailsChangedAt)}
            </span>
            <span className="block text-muted-foreground">
              {formatNairobiTime(row.original.detailsChangedAt)}
            </span>
          </>
        ) : (
          <span className="block leading-6 text-muted-foreground">Never</span>
        ),
      meta: { kind: "date", collapse: "md", label: "Details changed" },
      ...sortOptions("changed"),
    },
  ];
}

export function PayeePhoneCard({
  payee,
  onOpen,
}: {
  payee: Payee;
  onOpen: () => void;
}): JSX.Element {
  return (
    <PhoneCard
      mark={
        <EntityMark
          name={payee.name}
          kind={isPerson(payee) ? "person" : "business"}
        />
      }
      title={payee.name}
      sub={`${KIND_LABELS[payee.kind]} · ${payee.details ? METHOD_LABELS[payee.details.method] : "No payment details yet"}`}
      flags={
        payee.secondConfirmationUntil ? (
          <StatusBadge tone="waiting">{RECENTLY_CHANGED_LABEL}</StatusBadge>
        ) : null
      }
      onOpen={onOpen}
    />
  );
}
