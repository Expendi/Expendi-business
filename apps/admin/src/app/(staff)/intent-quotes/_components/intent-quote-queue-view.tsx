"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import type { StaffIntentQuoteSummary } from "@expendi-business/shared";

import {
  INTENT_QUOTE_PURPOSE_LABELS,
  IntentQuoteStatusBadge,
} from "~/components/intent-quote-status";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { linkClass, secondaryButton } from "~/components/styles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime, formatUsdc } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

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
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">NEAR Intents</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Base hops, USDC payouts to other chains and sweeps whose outcome is
        unclear. Resolving one says what the chain shows became of its USDC;
        staff never send or re-send anything.
      </p>
      {companyId ? (
        <p className="mt-2 text-sm">
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
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = { companyId, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const result = useQuery({
    queryKey: queryKeys.intentQuoteQueue(query),
    queryFn: () => api.intentQuotes.queue(query),
    placeholderData: keepPreviousData,
  });

  if (result.isPending) {
    return <PageLoading label="Loading quotes…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const { quotes, nextCursor } = result.data;
  return (
    <div className="mt-4">
      {quotes.length === 0 ? (
        <PageEmpty title="Nothing needs attention.">
          NEAR Intents quotes under review will appear here.
        </PageEmpty>
      ) : (
        <IntentQuotesTable quotes={quotes} />
      )}
      <nav
        aria-label="Pages"
        className="mt-4 flex flex-wrap items-center gap-3 text-sm"
      >
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

function IntentQuotesTable({
  quotes,
}: {
  quotes: readonly StaffIntentQuoteSummary[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Table aria-label="NEAR Intents quotes">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Created</TableHead>
            <TableHead scope="col">Company</TableHead>
            <TableHead scope="col">For</TableHead>
            <TableHead scope="col">Amount</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Holds / reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotes.map((quote) => (
            <TableRow key={quote.id}>
              <TableCell>
                <Link href={`/intent-quotes/${quote.id}`} className={linkClass}>
                  {formatNairobiTime(quote.createdAt)}
                </Link>
              </TableCell>
              <TableCell className="min-w-40 max-w-64 break-words whitespace-normal">
                <Link
                  href={`/companies/${quote.organization.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {quote.organization.name}
                </Link>
              </TableCell>
              <TableCell>
                {INTENT_QUOTE_PURPOSE_LABELS[quote.purpose]}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatUsdc(quote.amountOut)}
              </TableCell>
              <TableCell>
                <IntentQuoteStatusBadge status={quote.status} />
                <span className="block text-xs text-stone-500">
                  1Click: {quote.oneClickStatus ?? "—"}
                </span>
              </TableCell>
              <TableCell className="min-w-56 max-w-sm break-words whitespace-normal">
                <span className="block text-xs text-stone-600">
                  {quote.payoutsInReview} payout
                  {quote.payoutsInReview === 1 ? "" : "s"} under review
                  {quote.openSends > 0
                    ? ` · ${quote.openSends} open company wallet send`
                    : ""}
                </span>
                {quote.failure ? (
                  <span className="block text-xs text-stone-600">
                    {quote.failure}
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
