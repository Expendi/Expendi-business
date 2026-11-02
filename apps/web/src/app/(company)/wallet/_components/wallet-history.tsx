"use client";

import type { JSX } from "react";

import type { WalletHistoryItem } from "@expendi-business/shared";

import {
  cellClass,
  headCellClass,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  describeCounterparty,
  formatSignedUsdc,
  PAYOUT_STATUS_LABELS,
  TONE_CLASSES,
  TRANSACTION_TYPE_LABELS,
} from "./history-display";
import { shortAddress } from "./usdc-amount";
import { useWalletHistory } from "./wallet-api";

/** Every deposit, payment, refund and withdrawal, newest first (spec §6.9). */
export function WalletHistory({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const history = useWalletHistory(organizationId);

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h2 id="history-heading" className="text-base font-semibold">
        History
      </h2>
      {history.isPending ? (
        <p className="text-sm text-stone-500">Loading the history…</p>
      ) : history.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(history.error)}</p>
          <button
            type="button"
            onClick={() => void history.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <HistoryTable
          items={history.data.pages.flatMap((page) => page.items)}
          hasMore={history.hasNextPage}
          loadingMore={history.isFetchingNextPage}
          onLoadMore={() => void history.fetchNextPage()}
        />
      )}
    </section>
  );
}

function HistoryTable({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: WalletHistoryItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        Nothing yet. Deposits show up here once they arrive.
      </p>
    );
  }
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className={tableClass}>
          <thead className="bg-stone-100 text-stone-600">
            <tr>
              <th scope="col" className={headCellClass}>
                When
              </th>
              <th scope="col" className={headCellClass}>
                Type
              </th>
              <th scope="col" className={headCellClass}>
                Details
              </th>
              <th scope="col" className={`${headCellClass} text-right`}>
                USDC
              </th>
              <th scope="col" className={headCellClass}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const status = item.payout
                ? PAYOUT_STATUS_LABELS[item.payout.status]
                : null;
              return (
                <tr key={item.id} className="border-t border-stone-200">
                  <td className={`${cellClass} whitespace-nowrap`}>
                    {formatNairobiDateTime(item.createdAt)}
                  </td>
                  <td className={cellClass}>
                    {TRANSACTION_TYPE_LABELS[item.type]}
                  </td>
                  <td className={cellClass}>
                    {describeCounterparty(item) ?? "—"}
                    {item.txHash ? (
                      <span className="block font-mono text-xs text-stone-500">
                        {shortAddress(item.txHash)}
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
                  >
                    {formatSignedUsdc(item.usdcAmount)}
                  </td>
                  <td className={cellClass}>
                    {status ? (
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONE_CLASSES[status.tone]}`}
                      >
                        {status.label}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className={`mt-4 ${secondaryButton}`}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
