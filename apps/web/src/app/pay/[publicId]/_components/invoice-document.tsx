import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { CircleCheckIcon } from "lucide-react";

import type { PublicInvoice } from "@expendi-business/shared";

import { formatIsoDate } from "~/lib/dates";
import { formatRateBps, formatUsd } from "./pay-format";

const STATUS_LABELS: Record<PublicInvoice["status"], string> = {
  open: "Open",
  paid: "Paid",
  void: "Void",
};

const STATUS_TONES: Record<PublicInvoice["status"], string> = {
  open: "bg-warn-50 text-warn-700",
  paid: "bg-success-50 text-success-700",
  void: "bg-gray-100 text-gray-700",
};

function Pill({
  tone,
  children,
}: {
  tone: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-(--w-ui)",
        tone,
      )}
    >
      {children}
    </span>
  );
}

/** The invoice itself, as the customer sees and prints it. */
export function InvoiceDocument({
  invoice,
  receiptEmail,
}: {
  invoice: PublicInvoice;
  /** Set when the customer paid on this page, so the banner can say so. */
  receiptEmail?: string;
}): JSX.Element {
  const { from, billTo } = invoice;
  const amountLabel = invoice.status === "open" ? "Amount due" : "Total";

  return (
    <article
      aria-labelledby="invoice-heading"
      className="rounded-panel border border-gray-200 bg-surface p-5 shadow-panel sm:p-8 print:border-0 print:p-0 print:shadow-none"
    >
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={STATUS_TONES[invoice.status]}>
            {STATUS_LABELS[invoice.status]}
          </Pill>
          {invoice.overdue ? (
            <Pill tone="bg-error-50 text-error-700">Overdue</Pill>
          ) : null}
        </div>
        <h1
          id="invoice-heading"
          className="text-2xl leading-8 font-(--w-heading) text-gray-900"
        >
          Invoice {invoice.number} from {from.name}
        </h1>
        <div>
          <p className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
            {amountLabel}
          </p>
          <p className="mt-1 text-[32px] leading-10 font-(--w-display) text-gray-900 tabular-nums">
            {formatUsd(invoice.totalCents)}
          </p>
        </div>
      </header>

      {invoice.status === "paid" ? (
        <StatusNote tone="success">
          {receiptEmail === undefined
            ? "This invoice has been paid."
            : `Paid. A receipt is on its way to ${receiptEmail}.`}
        </StatusNote>
      ) : null}
      {invoice.status === "void" ? (
        <StatusNote tone="neutral">This invoice was cancelled.</StatusNote>
      ) : null}

      <dl className="mt-8 grid gap-6 sm:grid-cols-2">
        <Party label="From">
          <strong className="font-(--w-title)">{from.name}</strong>
          {from.kraPin === null ? null : <span>KRA PIN {from.kraPin}</span>}
        </Party>
        <Party label="Bill to">
          <strong className="font-(--w-title)">{billTo.name}</strong>
          <span className="break-all">{billTo.email}</span>
          {billTo.address === null ? null : (
            <span className="whitespace-pre-line">{billTo.address}</span>
          )}
          {billTo.taxId === null ? null : <span>Tax ID {billTo.taxId}</span>}
        </Party>
        <Party label="Issued">
          <span>{formatIsoDate(invoice.issueOn)}</span>
        </Party>
        <Party label="Due">
          <span>{formatIsoDate(invoice.dueOn)}</span>
        </Party>
      </dl>

      <ul className="mt-8 divide-y divide-gray-200 border-y border-gray-200">
        {invoice.lines.map((line) => (
          <li
            key={line.id}
            className="flex items-start justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-base leading-6 font-(--w-title) break-words text-gray-900">
                {line.description}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {line.quantity} × {formatUsd(line.unitPriceCents)}
              </p>
            </div>
            <p className="shrink-0 text-base leading-6 font-medium text-gray-900 tabular-nums">
              {formatUsd(line.amountCents)}
            </p>
          </li>
        ))}
      </ul>

      <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-2 text-sm">
        <TotalRow label="Subtotal" value={formatUsd(invoice.subtotalCents)} />
        {invoice.taxRateBps === null ? null : (
          <TotalRow
            label={`${invoice.taxLabel} (${formatRateBps(invoice.taxRateBps)})`}
            value={formatUsd(invoice.taxCents)}
          />
        )}
        <TotalRow strong label="Total" value={formatUsd(invoice.totalCents)} />
      </dl>

      {invoice.note === null ? null : (
        <section className="mt-8">
          <h2 className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
            Note
          </h2>
          <p className="mt-1 text-sm whitespace-pre-line text-gray-700">
            {invoice.note}
          </p>
        </section>
      )}
    </article>
  );
}

function StatusNote({
  tone,
  children,
}: {
  tone: "success" | "neutral";
  children: ReactNode;
}): JSX.Element {
  return (
    <p
      role="status"
      className={cn(
        "mt-6 flex items-center gap-2 rounded-control px-3 py-2.5 text-sm font-(--w-ui)",
        tone === "success"
          ? "bg-success-50 text-success-700"
          : "bg-gray-100 text-gray-700",
      )}
    >
      {tone === "success" ? (
        <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : null}
      {children}
    </p>
  );
}

function Party({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 flex flex-col text-sm text-gray-700">{children}</dd>
    </div>
  );
}

function TotalRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 tabular-nums",
        strong
          ? "border-t border-gray-200 pt-2 text-base font-(--w-title) text-gray-900"
          : "text-gray-700",
      )}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
