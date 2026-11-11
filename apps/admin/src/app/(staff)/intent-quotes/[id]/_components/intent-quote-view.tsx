"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";

import type { StaffIntentQuoteDetail } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import { PageHeader } from "~/components/data/page-header";
import {
  INTENT_QUOTE_PURPOSE_LABELS,
  IntentQuoteStatusBadge,
} from "~/components/intent-quote-status";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PayoutsTable } from "~/components/payouts-table";
import { linkClass } from "~/components/styles";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
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
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          NEAR Intents
        </Link>
      </p>
      <div className="mt-2">
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-3">
              <span>
                {INTENT_QUOTE_PURPOSE_LABELS[quote.purpose]} of{" "}
                {formatUsdc(quote.amountOut)}
              </span>
              <IntentQuoteStatusBadge status={quote.status} />
            </span>
          }
          subtitle={
            <>
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
            </>
          }
        />
      </div>
      {quote.failure ? (
        <p className="mt-3 rounded-md bg-warn-50 px-3 py-2 text-sm">
          {quote.failure}
        </p>
      ) : null}

      <div className="mt-4">
        {!canAct ? (
          <p className="text-sm text-muted-foreground">
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
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2>What 1Click and the chains show</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <QuoteEvidence quoteId={quote.id} />
        </CardContent>
      </Card>

      <Card className="mt-6 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>
            <h2>Payouts</h2>
          </CardTitle>
        </CardHeader>
        {quote.payouts.length === 0 ? (
          <PageEmpty title="No payouts.">
            This quote moves the company&apos;s money between its own wallets.
          </PageEmpty>
        ) : (
          <PayoutsTable payouts={quote.payouts} showCompany={false} />
        )}
      </Card>

      <Card className="mt-6 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>
            <h2>Audit trail</h2>
          </CardTitle>
          <CardAction>
            <Link href={auditHref} className={cn(linkClass, "text-sm")}>
              Open in the audit log, with before and after
            </Link>
          </CardAction>
        </CardHeader>
        {quote.auditTrail.length === 0 ? (
          <PageEmpty title="No audit entries yet." />
        ) : (
          <ol className="divide-y divide-border px-4 text-sm sm:px-6">
            {quote.auditTrail.map((entry) => (
              <li key={entry.id} className="py-4 break-words">
                <span className="text-muted-foreground">
                  {formatNairobiTime(entry.occurredAt)}
                </span>{" "}
                <span className="font-mono text-xs">{entry.action}</span> by{" "}
                {entry.actor.email ?? entry.actor.id}
              </li>
            ))}
          </ol>
        )}
      </Card>
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
  return <QuoteEvidenceSummary evidence={result.data} />;
}
