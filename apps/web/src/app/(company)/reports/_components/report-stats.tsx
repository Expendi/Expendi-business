import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import {
  BanknoteIcon,
  CheckIcon,
  ClockIcon,
  ImagesIcon,
  ReceiptTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { ReportMonthSummary } from "@expendi-business/shared";

import { KesTotal, Money } from "~/components/data/money";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { ErrorState } from "~/components/data/states";
import { approxKesTotal } from "~/lib/money";
import {
  etimsSub,
  moneyOutSub,
  outstandingSub,
  receiptsSub,
} from "./reports-display";

/** Plain numbers about the month's export; never clickable. */
export function ReportStats({
  summary,
  change,
  partial,
  rate,
}: {
  summary: UseQueryResult<ReportMonthSummary>;
  /** How money out compares with the month before; null until spending loads. */
  change: string | null;
  partial: boolean;
  rate: string | null;
}): JSX.Element {
  if (summary.isPending) {
    return (
      <StatCards label="The month in the export">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatCards>
    );
  }
  if (summary.isError) {
    return (
      <div className="mt-4 rounded-panel border border-gray-200 bg-surface">
        <ErrorState
          title="The month's figures didn't load"
          onRetry={() => void summary.refetch()}
        />
      </div>
    );
  }
  const data = summary.data;
  const { outstanding, receipts, etims } = data;
  const owed = approxKesTotal({
    kes: outstanding.totalKes,
    usd: outstanding.totalUsdc,
    rate,
  });
  return (
    <div
      className={
        summary.isPlaceholderData
          ? "opacity-50 transition-opacity duration-200"
          : "transition-opacity duration-200"
      }
    >
      <StatCards label="The month in the export">
        <StatCard
          icon={BanknoteIcon}
          tone="total"
          label={partial ? "Money out so far" : "Money out"}
          value={<Money amount={data.moneyOut.totalKes} currency="KES" />}
          sub={moneyOutSub(data, change)}
        />
        <StatCard
          icon={outstanding.rows > 0 ? ClockIcon : CheckIcon}
          tone={
            outstanding.overdue > 0
              ? "attention"
              : outstanding.rows > 0
                ? "total"
                : "clear"
          }
          label="Outstanding bills"
          value={<KesTotal total={owed} />}
          sub={outstandingSub(data)}
        />
        <StatCard
          icon={receipts.expensesWithout > 0 ? TriangleAlertIcon : ImagesIcon}
          tone={receipts.expensesWithout > 0 ? "attention" : "total"}
          label="Receipts"
          value={receipts.files}
          sub={receiptsSub(data)}
        />
        <StatCard
          icon={etims.none > 0 ? TriangleAlertIcon : ReceiptTextIcon}
          tone={etims.none > 0 ? "attention" : "total"}
          label="With an eTIMS invoice"
          value={`${String(etims.attached)} of ${String(etims.rows)}`}
          sub={etimsSub(data)}
        />
      </StatCards>
    </div>
  );
}
