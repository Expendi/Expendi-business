"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { CursorPager } from "~/components/cursor-pager";
import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { linkClass } from "~/components/styles";
import { Card } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { intentQuoteColumns } from "./columns";

const PAGE_SIZE = 50;

/**
 * NEAR Intents quotes that need a person (spec §6.15): under review, or
 * settled by 1Click while a payout or company wallet send they hold was
 * left open, from every company or one.
 */
export function IntentQuoteQueueView() {
  const params = useSearchParams();
  const companyId = params.get("companyId") ?? undefined;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="NEAR Intents"
        subtitle="Base hops, USDC payouts to other chains and sweeps whose outcome is unclear. Resolving one says what the chain shows became of its USDC; staff never send or re-send anything."
      />
      {companyId ? (
        <p className="text-sm">
          One company only ·{" "}
          <Link href={`/companies/${companyId}`} className={linkClass}>
            Open the company
          </Link>{" "}
          ·{" "}
          <Link href="/intent-quotes" className={linkClass}>
            Show every company
          </Link>
        </p>
      ) : null}
      <QueueResults key={companyId ?? ""} companyId={companyId} />
    </section>
  );
}

function QueueResults({ companyId }: { companyId: string | undefined }) {
  const { api } = useStaffAuth();
  const router = useRouter();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = { companyId, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const result = useQuery({
    queryKey: queryKeys.intentQuoteQueue(query),
    queryFn: () => api.intentQuotes.queue(query),
    placeholderData: keepPreviousData,
  });
  const quotes = useMemo(() => result.data?.quotes ?? [], [result.data]);
  const table = useDataTable({
    data: quotes,
    columns: intentQuoteColumns,
    getRowId: (quote) => quote.id,
    manual: true,
    paginate: false,
  });

  if (result.isPending) {
    return <PageLoading label="Loading quotes…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const { nextCursor } = result.data;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {quotes.length === 0 ? (
        <PageEmpty title="Nothing needs attention.">
          NEAR Intents quotes under review will appear here.
        </PageEmpty>
      ) : (
        <DataTable
          table={table}
          caption="NEAR Intents quotes"
          onRowOpen={(quote) => router.push(`/intent-quotes/${quote.id}`)}
        />
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
