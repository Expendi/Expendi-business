"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { StaffIntentQuoteDetail } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import {
  INTENT_QUOTE_PURPOSE_LABELS,
  IntentQuoteStatusBadge,
} from "~/components/intent-quote-status";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PayoutsTable } from "~/components/payouts-table";
import { linkClass } from "~/components/styles";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime, formatUsdc } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import { QuoteEvidenceSummary, ResolveQuoteFlow } from "./resolve-flow";

const time = (iso: string | null) => (iso ? formatNairobiTime(iso) : "—");
const usdc = (units: string | null) => (units ? formatUsdc(units) : "—");
const chain = (name: keyof typeof PAYEE_CHAIN_NAMES | null) =>
  name ? PAYEE_CHAIN_NAMES[name] : "—";
const hashes = (list: readonly string[]) =>
  list.length === 0 ? "—" : list.join(", ");

/**
 * Whether staff can resolve the quote: it is under review, or 1Click
 * settled it while a payout or a company wallet send it holds was left
 * open.
 */
const resolvable = (quote: StaffIntentQuoteDetail) =>
  quote.status === "needs_review" ||
  ((quote.status === "succeeded" || quote.status === "refunded") &&
    (quote.payoutsInReview > 0 || quote.openSends > 0));

/** One NEAR Intents quote, with what's needed to check it against 1Click and the chains. */
export function IntentQuoteView({ quoteId }: { quoteId: string }) {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const result = useQuery({
    queryKey: queryKeys.intentQuote(quoteId),
    queryFn: () => api.intentQuotes.quote(quoteId),
  });

  if (result.isPending) {
    return <PageLoading label="Loading quote…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const quote = result.data;
  const auditHref = `/audit-log?entityType=intent_quote&entityId=${quote.id}`;

  return (
    <section className="max-w-5xl">
      <p className="text-sm">
        <Link
          href="/intent-quotes"
          className="text-stone-600 underline-offset-4 hover:underline"
        >
          NEAR Intents
        </Link>
      </p>
      <h1 className="mt-2 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
        {INTENT_QUOTE_PURPOSE_LABELS[quote.purpose]} of{" "}
        {formatUsdc(quote.amountOut)}
        <IntentQuoteStatusBadge status={quote.status} />
      </h1>
      <p className="mt-1 text-sm text-stone-600">
        <Link
          href={`/companies/${quote.organization.id}`}
          className={linkClass}
        >
          {quote.organization.name}
        </Link>{" "}
        · {chain(quote.originChain)} to {chain(quote.destinationChain)} ·{" "}
        <Link href={auditHref} className={linkClass}>
          Audit trail
        </Link>
      </p>
      {quote.failure ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">
          {quote.failure}
        </p>
      ) : null}

      <div className="mt-4">
        {!canAct ? (
          <p className="text-sm text-stone-500">
            Resolving needs an ops admin.
          </p>
        ) : resolvable(quote) ? (
          <ResolveQuoteFlow quoteId={quote.id} />
        ) : null}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2>Details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_minmax(0,1fr)]">
            {(
              [
                ["Quote ID", quote.id],
                ["Sent to the deposit address", usdc(quote.amountIn)],
                ["Recipient receives", usdc(quote.amountOut)],
                ["Least the recipient receives", usdc(quote.minAmountOut)],
                ["Deposit address", quote.depositAddress],
                ["Recipient", quote.recipient],
                ["Refund address", quote.refundTo],
                ["Deadline", time(quote.deadline)],
                ["Deposit started", time(quote.depositStartedAt)],
                ["Deposit transaction", quote.depositTxHash ?? "—"],
                ["Company wallet send", quote.companyWalletSendId ?? "—"],
                ["Privy transaction", quote.depositPrivyTransactionId ?? "—"],
                [
                  "1Click status",
                  quote.oneClickStatus
                    ? `${quote.oneClickStatus} (checked ${time(quote.oneClickCheckedAt)})`
                    : "—",
                ],
                ["1Click NEAR transactions", hashes(quote.nearTxHashes)],
                [
                  "1Click origin transactions",
                  hashes(quote.originChainTxHashes),
                ],
                [
                  "1Click destination transactions",
                  hashes(quote.destinationChainTxHashes),
                ],
                ["Deposited, per 1Click", usdc(quote.depositedAmount)],
                ["Refunded, per 1Click", usdc(quote.refundedAmount)],
                ["Refund reason", quote.refundReason ?? "—"],
                ["Created", time(quote.createdAt)],
                ["Settled", time(quote.settledAt)],
                ["Last change", time(quote.updatedAt)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-stone-500">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <h2 className="mt-8 text-base font-semibold">
        What 1Click and the chains show
      </h2>
      <QuoteEvidence quoteId={quote.id} />

      <h2 className="mt-8 text-base font-semibold">Payouts</h2>
      {quote.payouts.length === 0 ? (
        <PageEmpty title="No payouts.">
          This quote moves the company&apos;s money between its own wallets.
        </PageEmpty>
      ) : (
        <div className="mt-3">
          <PayoutsTable payouts={quote.payouts} showCompany={false} />
        </div>
      )}

      <h2 className="mt-8 text-base font-semibold">Audit trail</h2>
      {quote.auditTrail.length === 0 ? (
        <PageEmpty title="No audit entries yet." />
      ) : (
        <ol className="mt-3 divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm sm:px-6">
          {quote.auditTrail.map((entry) => (
            <li key={entry.id} className="py-4 break-words">
              <span className="text-stone-500">
                {formatNairobiTime(entry.occurredAt)}
              </span>{" "}
              <span className="font-mono text-xs">{entry.action}</span> by{" "}
              {entry.actor.email ?? entry.actor.id}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-sm">
        <Link href={auditHref} className={linkClass}>
          Open in the audit log, with before and after
        </Link>
      </p>
    </section>
  );
}

function QuoteEvidence({ quoteId }: { quoteId: string }) {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.intentQuoteEvidence(quoteId),
    queryFn: () => api.intentQuotes.evidence(quoteId),
  });
  if (result.isPending) {
    return <PageLoading label="Asking 1Click and reading the chains…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  return (
    <div className="mt-3 rounded-xl border border-border bg-card px-4 pb-4 sm:px-6">
      <QuoteEvidenceSummary evidence={result.data} />
    </div>
  );
}
