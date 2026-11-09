"use client";

import type { JSX } from "react";
import {
  FilterXIcon,
  ReceiptTextIcon,
  ShoppingBagIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";

import type { CardPurchase } from "@expendi-business/shared";

import type { CardPurchaseFilters } from "~/lib/query-keys";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import { AmountStack } from "~/components/data/money";
import { ResultsBody, ResultsFoot } from "~/components/data/results";
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  TableSkeletonRows,
  Td,
  Th,
} from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";
import { formatNairobiDate } from "~/lib/dates";
import { useCardPurchases } from "./cards-api";
import {
  cardLabel,
  CHANGED_AFTER_EXPENSE_NOTE,
  hasPurchaseFilter,
  PURCHASE_STATUS,
  purchaseAmount,
  REFUND_NOTE,
} from "./cards-display";
import { PurchaseSheet } from "./purchase-sheet";
import { Usd } from "./usd";

const REFUND_META = "Refund · the books aren't adjusted";

function PurchaseFlags({ purchase }: { purchase: CardPurchase }): JSX.Element {
  return (
    <>
      {purchase.needsReceipt ? (
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

function amountOf(purchase: CardPurchase): JSX.Element {
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

/**
 * The company's Card purchases and refunds, newest first, a page at a time.
 * A refund reads differently and says the books aren't adjusted.
 */
export function PurchasesResults({
  organizationId,
  canAct,
  filters,
  openId,
  onOpen,
  onClose,
  onClearFilters,
}: {
  organizationId: string;
  canAct: boolean;
  filters: CardPurchaseFilters;
  openId: string | null;
  onOpen: (purchaseId: string) => void;
  onClose: () => void;
  onClearFilters: () => void;
}): JSX.Element {
  const purchases = useCardPurchases(organizationId, filters);
  const rows = purchases.data?.pages.flatMap((page) => page.purchases) ?? [];
  const ids = rows.map((row) => row.id);
  const open = openId ? rows.find((row) => row.id === openId) : undefined;
  const index = open ? ids.indexOf(open.id) : -1;
  const filtered = hasPurchaseFilter(filters);

  return (
    <>
      <ResultsBody
        id="cards-results"
        busy={purchases.isPending}
        refreshing={purchases.isPlaceholderData}
      >
        {purchases.isPending ? (
          <DataTable caption="Loading purchases">
            <tbody>
              <TableSkeletonRows rows={6} columns={5} />
            </tbody>
          </DataTable>
        ) : purchases.isError ? (
          <ErrorState
            title="Purchases didn't load"
            onRetry={() => void purchases.refetch()}
          >
            {describeApiError(purchases.error)}
          </ErrorState>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={filtered ? FilterXIcon : ShoppingBagIcon}
            title={
              filtered ? "No purchases match these filters" : "No purchases yet"
            }
            action={
              filtered ? (
                <Button variant="outline" size="md" onClick={onClearFilters}>
                  Clear all
                </Button>
              ) : null
            }
          >
            {filtered ? null : "They show here as soon as a card is used."}
          </EmptyState>
        ) : (
          <>
            <PurchaseTable
              rows={rows}
              openId={open?.id ?? null}
              onOpen={onOpen}
            />
            <ResultsFoot>
              <span>Showing {rows.length}</span>
              {purchases.hasNextPage ? (
                <Button
                  variant="outline"
                  size="md"
                  disabled={purchases.isFetchingNextPage}
                  onClick={() => void purchases.fetchNextPage()}
                >
                  {purchases.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              ) : null}
            </ResultsFoot>
          </>
        )}
      </ResultsBody>

      {open ? (
        <PurchaseSheet
          organizationId={organizationId}
          purchase={open}
          canAct={canAct}
          index={index}
          total={ids.length}
          onStep={(delta) => {
            const next = ids[index + delta];
            if (next) onOpen(next);
          }}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function PurchaseTable({
  rows,
  openId,
  onOpen,
}: {
  rows: readonly CardPurchase[];
  openId: string | null;
  onOpen: (purchaseId: string) => void;
}): JSX.Element {
  return (
    <>
      <DataTable caption="Card purchases">
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Holder and card</Th>
            <Th>Merchant</Th>
            <Th align="end">Amount</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((purchase) => {
            const status = PURCHASE_STATUS[purchase.status];
            const holder = personName(purchase.holder);
            const refund = purchase.kind === "refund";
            return (
              <DataRow
                key={purchase.id}
                open={purchase.id === openId}
                onOpen={() => onOpen(purchase.id)}
              >
                <Td kind="date">{formatNairobiDate(purchase.authorizedAt)}</Td>
                <Td>
                  <span className="flex items-start gap-2.5">
                    <EntityMark name={holder} kind="person" />
                    <span className="min-w-0">
                      <span className="block whitespace-nowrap text-gray-900">
                        {holder}
                      </span>
                      <span className="block whitespace-nowrap text-gray-500 tabular-nums">
                        {cardLabel(purchase.card)}
                      </span>
                    </span>
                  </span>
                </Td>
                <Td kind="main">
                  <RowTitle onOpen={() => onOpen(purchase.id)}>
                    {purchase.merchant}
                  </RowTitle>
                  <RowMeta text={refund ? REFUND_META : purchase.category.name}>
                    {refund ? (
                      <Mini icon={Undo2Icon} label={REFUND_NOTE} />
                    ) : null}
                    <PurchaseFlags purchase={purchase} />
                  </RowMeta>
                </Td>
                <Td align="end">{amountOf(purchase)}</Td>
                <Td>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Card purchases">
        {rows.map((purchase) => {
          const status = PURCHASE_STATUS[purchase.status];
          const holder = personName(purchase.holder);
          const refund = purchase.kind === "refund";
          return (
            <PhoneCard
              key={purchase.id}
              mark={<EntityMark name={holder} kind="person" />}
              title={purchase.merchant}
              sub={
                refund
                  ? REFUND_META
                  : `${holder} · ${formatNairobiDate(purchase.authorizedAt)}`
              }
              flags={
                <>
                  {refund ? (
                    <StatusBadge tone="moving">Refund</StatusBadge>
                  ) : null}
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  <PurchaseFlags purchase={purchase} />
                </>
              }
              aside={amountOf(purchase)}
              onOpen={() => onOpen(purchase.id)}
            />
          );
        })}
      </PhoneCards>
    </>
  );
}
