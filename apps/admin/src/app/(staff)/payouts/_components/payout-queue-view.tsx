"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import type { StaffPayoutQueueStatus } from "@expendi-business/shared";
import { STAFF_PAYOUT_QUEUE_STATUSES } from "@expendi-business/shared";

import { PayoutsTable } from "~/components/payouts-table";
import { linkClass, secondaryButton } from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { toQueryString } from "~/lib/internal-api";
import { queryKeys } from "~/lib/query-keys";

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<StaffPayoutQueueStatus, string> = {
  needs_review: "Needs review",
  failed: "Failed",
};

function isQueueStatus(value: string | null): value is StaffPayoutQueueStatus {
  return (STAFF_PAYOUT_QUEUE_STATUSES as readonly (string | null)[]).includes(
    value,
  );
}

/**
 * Payouts that need a person (spec §6.15): under review or failed, for
 * every kind of payment, from every company or one.
 */
export function PayoutQueueView() {
  const params = useSearchParams();
  const rawStatus = params.get("status");
  const status = isQueueStatus(rawStatus) ? rawStatus : undefined;
  const companyId = params.get("companyId") ?? undefined;
  const tabs: { label: string; status?: StaffPayoutQueueStatus }[] = [
    { label: "All" },
    ...STAFF_PAYOUT_QUEUE_STATUSES.map((value) => ({
      label: STATUS_LABELS[value],
      status: value,
    })),
  ];

  return (
    <section>
      <h1 className="text-xl font-semibold">Payouts</h1>
      <p className="mt-1 text-sm text-stone-600">
        Claims, bills, floats, payroll runs and withdrawals that need review or
        have failed. Staff never send or retry a payout; the company&apos;s
        admin does.
      </p>
      {companyId ? (
        <p className="mt-2 text-sm">
          One company only ·{" "}
          <Link href={`/companies/${companyId}`} className={linkClass}>
            Open the company
          </Link>{" "}
          ·{" "}
          <Link
            href={`/payouts${toQueryString({ status })}`}
            className={linkClass}
          >
            Show every company
          </Link>
        </p>
      ) : null}
      <nav aria-label="Status" className="mt-4 flex gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={`/payouts${toQueryString({ status: tab.status, companyId })}`}
            aria-current={tab.status === status ? "page" : undefined}
            className={
              tab.status === status
                ? "rounded-md bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700"
                : "rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
            }
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <QueueResults
        key={`${status ?? "all"}:${companyId ?? ""}`}
        status={status}
        companyId={companyId}
      />
    </section>
  );
}

function QueueResults({
  status,
  companyId,
}: {
  status: StaffPayoutQueueStatus | undefined;
  companyId: string | undefined;
}) {
  const { api } = useStaffAuth();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = { status, companyId, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const result = useQuery({
    queryKey: queryKeys.payoutQueue(query),
    queryFn: () => api.ops.payoutQueue(query),
    placeholderData: keepPreviousData,
  });

  if (result.isPending) {
    return <p className="mt-6 text-sm text-stone-500">Loading…</p>;
  }
  if (result.isError) {
    return (
      <p role="alert" className="mt-6 text-sm text-error-700">
        {describeApiError(result.error)}
      </p>
    );
  }
  const { payouts, nextCursor } = result.data;
  return (
    <div className="mt-4">
      {payouts.length === 0 ? (
        <p className="text-sm text-stone-500">Nothing needs attention.</p>
      ) : (
        <PayoutsTable payouts={payouts} showCompany />
      )}
      <nav aria-label="Pages" className="mt-4 flex items-center gap-4 text-sm">
        <button
          type="button"
          disabled={cursors.length === 1}
          onClick={() => setCursors((stack) => stack.slice(0, -1))}
          className={secondaryButton}
        >
          Newer
        </button>
        <span className="text-stone-600">Page {cursors.length}</span>
        <button
          type="button"
          disabled={!nextCursor || result.isPlaceholderData}
          onClick={() => {
            if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
          }}
          className={secondaryButton}
        >
          Older
        </button>
      </nav>
    </div>
  );
}
