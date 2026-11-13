import type { JSX } from "react";
import { cn } from "cn";
import { ReceiptTextIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import Link from "next/link";

import type {
  CardLoad,
  CardPurchase,
  ExpendiCard,
} from "@expendi-business/shared";

import type { CardSortKey } from "./cards-display";
import type { DataTableColumnDef } from "~/components/data/data-table";
import { textLinkClass } from "~/components/data/actions";
import { EntityMark, Mini, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTableColumnHeader } from "~/components/data/data-table";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatNairobiDate } from "~/lib/dates";
import { formatKes } from "~/lib/money";
import {
  asksForReceipt,
  CARD_SORT_FIRST,
  CARD_STATE,
  cardLabel,
  CHANGED_AFTER_EXPENSE_NOTE,
  holderName,
  maskedLastFour,
  matchedPaymentOf,
  NEEDS_ANSWER,
  needsAnswer,
  PURCHASE_STATUS,
  purchaseAmount,
  REFUND_NOTE,
} from "./cards-display";
import { Usd } from "./usd";

export const CARD_SORT_KEYS: readonly CardSortKey[] = [
  "card",
  "holder",
  "spent",
  "limit",
];

export const REFUND_META = "Refund · the books aren't adjusted";

function sortable(key: CardSortKey) {
  return {
    sortDescFirst: CARD_SORT_FIRST[key] === "desc",
    enableSortingRemoval: false,
  } as const;
}

export function cardColumns({
  onOpen,
}: {
  onOpen: (cardId: string) => void;
}): DataTableColumnDef<ExpendiCard>[] {
  return [
    {
      id: "card",
      accessorFn: (card) => card.nickname,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Card" />
      ),
      cell: ({ row }) => {
        const card = row.original;
        return (
          <>
            <RowTitle onOpen={() => onOpen(card.id)}>{card.nickname}</RowTitle>
            <RowMeta
              text={`${maskedLastFour(card.lastFour)} · ${card.defaultCategory.name}`}
            />
          </>
        );
      },
      meta: { kind: "main", label: "Card" },
      enableHiding: false,
      ...sortable("card"),
    },
    {
      id: "holder",
      accessorFn: (card) => holderName(card.holder),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Holder" />
      ),
      cell: ({ row }) => {
        const holder = holderName(row.original.holder);
        return (
          <span className="flex items-center gap-2.5 whitespace-nowrap">
            <HolderMark holder={row.original.holder} />
            {holder}
          </span>
        );
      },
      meta: { label: "Holder" },
      ...sortable("holder"),
    },
    {
      id: "state",
      header: "State",
      cell: ({ row }) => {
        const state = CARD_STATE[row.original.state];
        return <StatusBadge tone={state.tone}>{state.label}</StatusBadge>;
      },
      meta: { label: "State" },
      enableSorting: false,
    },
    {
      id: "spent",
      accessorFn: (card) => card.spentThisMonthUsdCents,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Spent this month" />
      ),
      cell: ({ row }) => (
        <AmountStack>
          <Usd cents={row.original.spentThisMonthUsdCents} />
        </AmountStack>
      ),
      meta: { align: "end", label: "Spent this month" },
      ...sortable("spent"),
    },
    {
      id: "limit",
      accessorFn: (card) => card.monthlyLimitUsdCents,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Monthly limit" />
      ),
      cell: ({ row }) => (
        <AmountStack>
          <Usd cents={row.original.monthlyLimitUsdCents} />
        </AmountStack>
      ),
      meta: { align: "end", label: "Monthly limit" },
      ...sortable("limit"),
    },
  ];
}

const rateLine = (load: CardLoad) =>
  `At KES ${load.usdKesRate} per USD · KES ${formatKes(load.amountKes)}`;

export function loadColumns(): DataTableColumnDef<CardLoad>[] {
  return [
    {
      id: "date",
      header: "Date",
      cell: ({ row }) => formatNairobiDate(row.original.createdAt),
      meta: { kind: "date", label: "Date" },
      enableSorting: false,
    },
    {
      id: "loadedBy",
      header: "Loaded by",
      cell: ({ row }) => (
        <>
          <RowTitle>{row.original.loadedBy}</RowTitle>
          <RowMeta text={rateLine(row.original)} />
        </>
      ),
      meta: { kind: "main", label: "Loaded by" },
      enableHiding: false,
      enableSorting: false,
    },
    {
      id: "amount",
      header: "Amount",
      cell: ({ row }) => (
        <AmountStack
          sub={<Money amount={row.original.amountKes} currency="KES" />}
        >
          <Usd cents={row.original.amountUsdCents} />
        </AmountStack>
      ),
      meta: { align: "end", label: "Amount" },
      enableSorting: false,
    },
    {
      id: "kind",
      header: "Kind",
      cell: ({ row }) =>
        row.original.simulated ? (
          <StatusBadge tone="quiet">Simulated</StatusBadge>
        ) : null,
      meta: { label: "Kind" },
      enableSorting: false,
    },
  ];
}

/** A person's initials, or the company's mark on a company-held card. */
export function HolderMark({
  holder,
}: {
  holder: ExpendiCard["holder"];
}): JSX.Element {
  return holder === null ? (
    <EntityMark name={holderName(holder)} />
  ) : (
    <EntityMark name={holderName(holder)} kind="person" />
  );
}

/** "Pays Vercel", linking to the bill once the purchase has paid it. */
export function PaysPayment({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element | null {
  const matched = matchedPaymentOf(purchase);
  if (!matched) return null;
  const label = `Pays ${matched.payeeName}`;
  return matched.billId ? (
    <Link
      href={`/bills?billId=${matched.billId}`}
      className={cn("text-xs leading-4 whitespace-nowrap", textLinkClass)}
    >
      {label}
    </Link>
  ) : (
    <span className="text-xs leading-4 whitespace-nowrap">{label}</span>
  );
}

/** The purchase's status, then "Needs an answer" while an admin hasn't said what it is. */
export function PurchaseStatus({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element {
  const status = PURCHASE_STATUS[purchase.status];
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      {needsAnswer(purchase) ? (
        <StatusBadge tone="waiting">{NEEDS_ANSWER}</StatusBadge>
      ) : null}
    </span>
  );
}

export function PurchaseFlags({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element {
  return (
    <>
      {asksForReceipt(purchase) ? (
        <Mini icon={ReceiptTextIcon} label="Needs a receipt" warn>
          Needs receipt
        </Mini>
      ) : null}
      {purchase.changedAfterExpense ? (
        <Mini icon={TriangleAlertIcon} label={CHANGED_AFTER_EXPENSE_NOTE} warn>
          Changed after recording
        </Mini>
      ) : null}
    </>
  );
}

export function PurchaseAmount({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element {
  const amount = purchaseAmount(purchase);
  const refund = purchase.kind === "refund";
  return (
    <AmountStack sub={amount.sub}>
      <Usd
        cents={amount.cents}
        plus={refund}
        className={refund ? "text-success-700" : undefined}
      />
    </AmountStack>
  );
}

export function purchaseColumns({
  onOpen,
}: {
  onOpen: (purchaseId: string) => void;
}): DataTableColumnDef<CardPurchase>[] {
  return [
    {
      id: "date",
      header: "Date",
      cell: ({ row }) => formatNairobiDate(row.original.authorizedAt),
      meta: { kind: "date", label: "Date" },
      enableSorting: false,
    },
    {
      id: "holder",
      header: "Holder and card",
      cell: ({ row }) => {
        const purchase = row.original;
        const holder = holderName(purchase.holder);
        return (
          <span className="flex items-start gap-2.5">
            <HolderMark holder={purchase.holder} />
            <span className="min-w-0">
              <span className="block whitespace-nowrap text-foreground">
                {holder}
              </span>
              <span className="block whitespace-nowrap text-muted-foreground tabular-nums">
                {cardLabel(purchase.card)}
              </span>
            </span>
          </span>
        );
      },
      meta: { label: "Holder and card" },
      enableSorting: false,
    },
    {
      id: "merchant",
      header: "Merchant",
      cell: ({ row }) => {
        const purchase = row.original;
        const refund = purchase.kind === "refund";
        return (
          <>
            <RowTitle onOpen={() => onOpen(purchase.id)}>
              {purchase.merchant}
            </RowTitle>
            <RowMeta text={refund ? REFUND_META : purchase.category.name}>
              {refund ? <Mini icon={Undo2Icon} label={REFUND_NOTE} /> : null}
              <PaysPayment purchase={purchase} />
              <PurchaseFlags purchase={purchase} />
            </RowMeta>
          </>
        );
      },
      meta: { kind: "main", label: "Merchant" },
      enableHiding: false,
      enableSorting: false,
    },
    {
      id: "amount",
      header: "Amount",
      cell: ({ row }) => <PurchaseAmount purchase={row.original} />,
      meta: { align: "end", label: "Amount" },
      enableSorting: false,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <PurchaseStatus purchase={row.original} />,
      meta: { label: "Status" },
      enableSorting: false,
    },
  ];
}
