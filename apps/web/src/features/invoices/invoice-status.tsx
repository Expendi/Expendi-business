import type { JSX } from "react";

import type {
  FundInChain,
  InvoicePaymentKind,
  InvoiceStatus,
  InvoiceTerms,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { CurrencyCode } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { formatCents } from "./invoice-money";

export const INVOICE_STATUSES: Readonly<
  Record<InvoiceStatus | "overdue", { label: string; tone: StatusTone }>
> = {
  draft: { label: "Draft", tone: "quiet" },
  open: { label: "Open", tone: "moving" },
  overdue: { label: "Overdue", tone: "overdue" },
  paid: { label: "Paid", tone: "paid" },
  void: { label: "Void", tone: "rejected" },
};

/** The status, and beside an open invoice that is late, a red "Overdue". */
export function InvoiceStatusBadges({
  status,
  overdue,
  className,
}: {
  status: InvoiceStatus;
  overdue: boolean;
  className?: string;
}): JSX.Element {
  const { label, tone } = INVOICE_STATUSES[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge tone={tone} className={className}>
        {label}
      </StatusBadge>
      {overdue ? (
        <StatusBadge tone="overdue" className={className}>
          {INVOICE_STATUSES.overdue.label}
        </StatusBadge>
      ) : null}
    </span>
  );
}

/** US dollars from cents, with the currency code small and muted. */
export function Usd({ cents }: { cents: string }): JSX.Element {
  return (
    <span className="whitespace-nowrap tabular-nums">
      <CurrencyCode code="USD" /> {formatCents(cents)}
    </span>
  );
}

export const TERMS_LABELS: Readonly<Record<InvoiceTerms, string>> = {
  on_receipt: "On receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  custom: "Custom date",
};

export const PAYMENT_KIND_LABELS: Readonly<Record<InvoicePaymentKind, string>> =
  {
    link: "Paid through link",
    matched: "Matched deposit",
    outside: "Marked paid",
  };

export const CHAIN_LABELS: Readonly<Record<FundInChain, string>> = {
  base: "Base",
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  solana: "Solana",
};

/** "0x12ab…9f0e", for a transaction hash or address in a narrow row. */
export function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
