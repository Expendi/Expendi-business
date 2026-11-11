"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import type { StaffPayoutQueueStatus } from "@expendi-business/shared";
import { STAFF_PAYOUT_QUEUE_STATUSES } from "@expendi-business/shared";

import { CursorPager } from "~/components/cursor-pager";
import { PageHeader } from "~/components/data/page-header";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PayoutsTable } from "~/components/payouts-table";
import { linkClass } from "~/components/styles";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
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
    <section className="flex flex-col gap-4">
      <PageHeader
        title="Payouts"
        subtitle="Claims, bills, floats, payroll runs and withdrawals that need review or have failed. Staff never send or retry a payout; the company's admin does."
      />
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
      <nav aria-label="Status" className="mt-6 flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={`/payouts${toQueryString({ status: tab.status, companyId })}`}
            aria-current={tab.status === status ? "page" : undefined}
            className={buttonVariants({
              variant: tab.status === status ? "secondary" : "ghost",
            })}
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
    return <PageLoading label="Loading payouts…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const { payouts, nextCursor } = result.data;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {payouts.length === 0 ? (
        <PageEmpty title="Nothing needs attention.">
          Payouts that need review or have failed will appear here.
        </PageEmpty>
      ) : (
        <PayoutsTable payouts={payouts} showCompany />
      )}
      <CursorPager
        page={cursors.length}
        hasPrevious={cursors.length > 1}
        hasNext={Boolean(nextCursor) && !result.isPlaceholderData}
        onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
        onNext={() => {
          if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
        }}
        previousLabel="Newer"
        nextLabel="Older"
      />
    </Card>
  );
}
