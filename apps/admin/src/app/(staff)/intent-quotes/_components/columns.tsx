import Link from "next/link";

import type { StaffIntentQuoteSummary } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import {
  INTENT_QUOTE_PURPOSE_LABELS,
  IntentQuoteStatusBadge,
} from "~/components/intent-quote-status";
import { plainColumn } from "~/components/plain-column";
import { formatNairobiTime, formatUsdc } from "~/lib/format";

/** What the quote holds open, in a line: payouts under review and company wallet sends. */
export function holdsSummary(
  quote: Pick<StaffIntentQuoteSummary, "payoutsInReview" | "openSends">,
): string {
  const payouts = `${quote.payoutsInReview} payout${
    quote.payoutsInReview === 1 ? "" : "s"
  } under review`;
  return quote.openSends > 0
    ? `${payouts} · ${quote.openSends} open company wallet send`
    : payouts;
}

export const intentQuoteColumns: DataTableColumnDef<StaffIntentQuoteSummary>[] =
  [
    plainColumn<StaffIntentQuoteSummary>({
      id: "created",
      title: "Created",
      value: (quote) => formatNairobiTime(quote.createdAt),
      cell: (quote) => (
        <Link
          href={`/intent-quotes/${quote.id}`}
          className="font-medium text-accent-foreground underline-offset-4 hover:underline"
        >
          {formatNairobiTime(quote.createdAt)}
        </Link>
      ),
    }),
    plainColumn<StaffIntentQuoteSummary>({
      id: "company",
      title: "Company",
      value: (quote) => quote.organization.name,
      cell: (quote) => (
        <Link
          href={`/companies/${quote.organization.id}`}
          className="wrap-anywhere underline-offset-4 hover:underline"
        >
          {quote.organization.name}
        </Link>
      ),
      meta: { className: "min-w-40 max-w-64 whitespace-normal" },
    }),
    plainColumn<StaffIntentQuoteSummary>({
      id: "for",
      title: "For",
      value: (quote) => INTENT_QUOTE_PURPOSE_LABELS[quote.purpose],
    }),
    plainColumn<StaffIntentQuoteSummary>({
      id: "amount",
      title: "Amount",
      value: (quote) => formatUsdc(quote.amountOut),
      cell: (quote) => (
        <span className="tabular-nums">{formatUsdc(quote.amountOut)}</span>
      ),
    }),
    plainColumn<StaffIntentQuoteSummary>({
      id: "status",
      title: "Status",
      value: (quote) => quote.status,
      cell: (quote) => (
        <>
          <IntentQuoteStatusBadge status={quote.status} />
          <span className="mt-1 block text-xs text-muted-foreground">
            1Click: {quote.oneClickStatus ?? "—"}
          </span>
        </>
      ),
    }),
    plainColumn<StaffIntentQuoteSummary>({
      id: "holds",
      title: "Holds / reason",
      value: (quote) => holdsSummary(quote),
      cell: (quote) => (
        <>
          <span className="block text-xs text-muted-foreground">
            {holdsSummary(quote)}
          </span>
          {quote.failure ? (
            <span className="block text-xs text-muted-foreground">
              {quote.failure}
            </span>
          ) : null}
        </>
      ),
      meta: { className: "min-w-56 max-w-sm whitespace-normal" },
    }),
  ];
