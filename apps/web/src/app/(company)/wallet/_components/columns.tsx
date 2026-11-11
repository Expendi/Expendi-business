import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import { ArrowDownLeftIcon, LandmarkIcon, Undo2Icon } from "lucide-react";

import type { WalletHistoryItem } from "@expendi-business/shared";

import type { TxKind } from "./wallet-display";
import type { DataTableColumnDef } from "~/components/data/data-table";
import { EntityMark, PhoneCard, RowTitle } from "~/components/data/cells";
import { StatusBadge } from "~/components/data/status-badge";
import { SignedUsdc } from "./balance-card";
import {
  nairobiTime,
  rowBadge,
  txDetail,
  txKind,
  txTitle,
} from "./wallet-display";

const TILES: Partial<Record<TxKind, LucideIcon>> = {
  deposit: ArrowDownLeftIcon,
  topup: ArrowDownLeftIcon,
  withdrawal: LandmarkIcon,
  refund: Undo2Icon,
};

/** A tile for the wallet's own movements; initials for whoever was paid. */
export function TxMark({ item }: { item: WalletHistoryItem }): JSX.Element {
  const kind = txKind(item);
  const Tile = TILES[kind];
  if (Tile) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-8 flex-none items-center justify-center rounded-control border border-border bg-card text-muted-foreground"
      >
        <Tile className="size-4" />
      </span>
    );
  }
  const subject = item.payout?.subjectType;
  const person =
    kind === "salary" || subject === "claim" || subject === "float";
  return (
    <EntityMark
      name={item.payout?.recipientName ?? txTitle(item)}
      kind={person ? "person" : "business"}
    />
  );
}

export function historyColumns(
  onOpen: (item: WalletHistoryItem) => void,
): DataTableColumnDef<WalletHistoryItem>[] {
  return [
    {
      id: "movement",
      accessorFn: txTitle,
      header: "Movement",
      cell: ({ row }) => (
        <span className="flex min-w-0 items-start gap-3.5">
          <TxMark item={row.original} />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original)}>
              {txTitle(row.original)}
            </RowTitle>
            <span className="block truncate text-muted-foreground">
              {txDetail(row.original)}
            </span>
          </span>
        </span>
      ),
      enableSorting: false,
      enableHiding: false,
      meta: { kind: "main", label: "Movement" },
    },
    {
      id: "status",
      accessorFn: (item) => rowBadge(item)?.label ?? "",
      header: "Status",
      cell: ({ row }) => {
        const badge = rowBadge(row.original);
        return badge ? (
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        ) : null;
      },
      enableSorting: false,
      meta: { label: "Status", className: "w-44" },
    },
    {
      id: "time",
      accessorFn: (item) => item.createdAt,
      header: "Time",
      cell: ({ row }) => nairobiTime(row.original.createdAt),
      enableSorting: false,
      meta: { kind: "date", label: "Time", className: "w-20" },
    },
    {
      id: "amount",
      accessorFn: (item) => item.usdcAmount,
      header: "Amount",
      cell: ({ row }) => (
        <span className="text-base leading-6 font-(--w-amount)">
          <SignedUsdc amount={row.original.usdcAmount} />
        </span>
      ),
      enableSorting: false,
      meta: { align: "end", label: "Amount", className: "w-52" },
    },
  ];
}

export function TxPhoneCard({
  item,
  onOpen,
}: {
  item: WalletHistoryItem;
  onOpen: () => void;
}): JSX.Element {
  const badge = rowBadge(item);
  return (
    <PhoneCard
      mark={<TxMark item={item} />}
      title={txTitle(item)}
      sub={txDetail(item)}
      flags={
        badge ? (
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        ) : null
      }
      aside={
        <span className="flex flex-col items-end gap-0.5">
          <span className="text-base leading-6 font-(--w-amount)">
            <SignedUsdc amount={item.usdcAmount} />
          </span>
          <span className="text-xs leading-4 text-muted-foreground tabular-nums">
            {nairobiTime(item.createdAt)}
          </span>
        </span>
      }
      onOpen={onOpen}
    />
  );
}
