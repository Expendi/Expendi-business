import type { JSX } from "react";
import { FilterXIcon, ShoppingBagIcon } from "lucide-react";
import { useMemo } from "react";

import type { CardPurchase } from "@expendi-business/shared";

import type { CardPurchaseFilters } from "~/lib/query-keys";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import { EntityMark, PhoneCard } from "~/components/data/cells";
import { DataTable, useDataTable } from "~/components/data/data-table";
import { ResultsBody, ResultsFoot } from "~/components/data/results";
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";
import { formatNairobiDate } from "~/lib/dates";
import { useCardPurchases } from "./cards-api";
import { hasPurchaseFilter, PURCHASE_STATUS } from "./cards-display";
import {
  PurchaseAmount,
  purchaseColumns,
  PurchaseFlags,
  REFUND_META,
} from "./columns";
import { PurchaseSheet } from "./purchase-sheet";
import { useStableOpen } from "./use-stable-open";

const NO_PURCHASES: readonly CardPurchase[] = [];

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
  const rows = useMemo(
    () =>
      purchases.data?.pages.flatMap((page) => page.purchases) ?? NO_PURCHASES,
    [purchases.data],
  );
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
          <PurchasesSkeleton />
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

function PurchasesSkeleton(): JSX.Element {
  const columns = useMemo(
    () => purchaseColumns({ onOpen: () => undefined }),
    [],
  );
  const table = useDataTable({
    data: NO_PURCHASES,
    columns,
    getRowId: (purchase) => purchase.id,
    paginate: false,
  });
  return <DataTable table={table} caption="Loading purchases" loading />;
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
  const open = useStableOpen(onOpen);
  const columns = useMemo(() => purchaseColumns({ onOpen: open }), [open]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (purchase) => purchase.id,
    manual: true,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption="Card purchases"
      onRowOpen={(purchase) => onOpen(purchase.id)}
      openRowId={openId}
      renderPhoneCard={(row) => {
        const purchase = row.original;
        const status = PURCHASE_STATUS[purchase.status];
        const holder = personName(purchase.holder);
        const refund = purchase.kind === "refund";
        return (
          <PhoneCard
            key={row.id}
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
            aside={<PurchaseAmount purchase={purchase} />}
            onOpen={() => onOpen(purchase.id)}
          />
        );
      }}
    />
  );
}
