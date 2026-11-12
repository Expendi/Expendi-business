"use client";

import type { JSX } from "react";
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import type {
  Invoice,
  InvoicePayment,
  InvoiceSummary,
} from "@expendi-business/shared";

import { TextLinkButton } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { bpsToPercent } from "~/features/invoices/invoice-money";
import {
  CHAIN_LABELS,
  InvoiceStatusBadges,
  PAYMENT_KIND_LABELS,
  shortHash,
  TERMS_LABELS,
  Usd,
} from "~/features/invoices/invoice-status";
import { useRemindInvoice } from "~/features/invoices/invoices-api";
import { describeApiError } from "~/lib/api";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { formatUsdc } from "~/lib/money";
import { InvoiceTotalsBlock } from "./invoice-totals";

export type InvoiceAction =
  "edit" | "send" | "delete" | "void" | "mark_paid" | "match" | "undo";

/** Under the sheet's title: the total, then the status. */
export function InvoiceSheetHeader({
  invoice,
}: {
  invoice: InvoiceSummary;
}): JSX.Element {
  return (
    <>
      <div className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
        <Usd cents={invoice.totalCents} />
      </div>
      <InvoiceStatusBadges
        status={invoice.status}
        overdue={invoice.overdue}
        className="mt-2"
      />
    </>
  );
}

export function InvoiceDetailSkeleton(): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading invoice"
      className="flex flex-col gap-4"
    >
      <Skel width="100%" height={20} />
      <Skel width="70%" height={20} />
      <Skel width="100%" height={96} />
      <Skel width="55%" height={20} />
    </div>
  );
}

function Party({
  label,
  name,
  lines,
}: {
  label: string;
  name: string;
  lines: readonly (string | null)[];
}): JSX.Element {
  return (
    <div className="min-w-0">
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-1 font-(--w-ui) [overflow-wrap:anywhere]">{name}</p>
      {lines.map((line) =>
        line ? (
          <p
            key={line}
            className="text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-line"
          >
            {line}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** One invoice: why it is void, who it is to and from, its lines and totals, its payments. */
export function InvoiceDetailBody({
  invoice,
  canAct,
  onUndo,
}: {
  invoice: Invoice;
  canAct: boolean;
  onUndo: (paymentId: string) => void;
}): JSX.Element {
  const { billTo, from } = invoice;
  return (
    <>
      {invoice.voidedReason ? (
        <Callout tone="neutral" icon={BanIcon}>
          <p>Voided: {invoice.voidedReason}</p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label="Issued">{formatIsoDate(invoice.issueOn)}</DetailItem>
        <DetailItem label="Due" sub={TERMS_LABELS[invoice.terms]}>
          {formatIsoDate(invoice.dueOn)}
        </DetailItem>
        {invoice.sentAt ? (
          <DetailItem label="Sent">
            {formatNairobiDate(invoice.sentAt)}
          </DetailItem>
        ) : null}
        {invoice.paidAt ? (
          <DetailItem label="Paid">
            {formatNairobiDate(invoice.paidAt)}
          </DetailItem>
        ) : null}
      </DetailList>

      <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
        <Party
          label="Bill to"
          name={billTo.name}
          lines={[
            billTo.email,
            billTo.address,
            billTo.taxId ? `Tax ID ${billTo.taxId}` : null,
          ]}
        />
        <Party
          label="From"
          name={from.name}
          lines={[from.kraPin ? `KRA PIN ${from.kraPin}` : null]}
        />
      </div>

      <section aria-label="Lines" className="flex flex-col">
        <SectionLabel>Lines</SectionLabel>
        <ul className="mt-1 flex flex-col">
          {invoice.lines.map((line) => (
            <li
              key={line.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t border-hairline py-2.5 first:border-t-0"
            >
              <span className="[overflow-wrap:anywhere]">
                {line.description}
              </span>
              <span className="text-right">
                <Usd cents={line.amountCents} />
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {line.quantity} × <Usd cents={line.unitPriceCents} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <InvoiceTotalsBlock
        subtotalCents={invoice.subtotalCents}
        taxCents={invoice.taxCents}
        taxLabel={invoice.taxLabel}
        taxRatePercent={
          invoice.taxRateBps === null ? null : bpsToPercent(invoice.taxRateBps)
        }
        totalCents={invoice.totalCents}
      />

      {invoice.note ? (
        <div>
          <SectionLabel>Note</SectionLabel>
          <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">
            {invoice.note}
          </p>
        </div>
      ) : null}

      {invoice.payments.length > 0 ? (
        <section aria-label="Payments" className="flex flex-col">
          <SectionLabel>Payments</SectionLabel>
          <ul className="mt-1 flex flex-col">
            {invoice.payments.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                canUndo={
                  canAct && invoice.status === "paid" && payment.kind !== "link"
                }
                onUndo={() => onUndo(payment.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function PaymentRow({
  payment,
  canUndo,
  onUndo,
}: {
  payment: InvoicePayment;
  canUndo: boolean;
  onUndo: () => void;
}): JSX.Element {
  const details = [
    payment.chain ? CHAIN_LABELS[payment.chain] : null,
    payment.txHash ? shortHash(payment.txHash) : null,
    payment.reference,
    payment.note,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <li className="flex items-start justify-between gap-4 border-t border-hairline py-2.5 first:border-t-0">
      <span className="min-w-0">
        <span className="block font-(--w-ui)">
          {PAYMENT_KIND_LABELS[payment.kind]}
        </span>
        <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {[formatIsoDate(payment.paidOn), ...details].join(" · ")}
        </span>
        {canUndo ? (
          <TextLinkButton className="mt-1 text-xs" onClick={onUndo}>
            Undo this payment
          </TextLinkButton>
        ) : null}
      </span>
      {payment.amountUsdc ? (
        <span className="whitespace-nowrap tabular-nums">
          {formatUsdc(payment.amountUsdc)} USDC
        </span>
      ) : null}
    </li>
  );
}

interface Notice {
  tone: "info" | "error";
  text: string;
}

/** The actions each status allows (docs/decisions/crypto-invoicing.md); accountants get none. */
export function InvoiceDetailFooter({
  organizationId,
  invoice,
  canAct,
  index,
  total,
  onAction,
}: {
  organizationId: string;
  /** Left out until the invoice's details load. */
  invoice: Invoice | undefined;
  canAct: boolean;
  index: number;
  total: number;
  onAction: (action: InvoiceAction) => void;
}): JSX.Element {
  const remind = useRemindInvoice(organizationId, invoice?.id ?? "");
  const [notice, setNotice] = useState<Notice | null>(null);

  async function copyLink(publicId: string) {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/pay/${publicId}`,
      );
      setNotice({ tone: "info", text: "Pay link copied." });
    } catch {
      setNotice({
        tone: "error",
        text: "Couldn't copy the link. Try again.",
      });
    }
  }

  function sendReminder() {
    setNotice(null);
    remind.mutate(undefined, {
      onSuccess: () => setNotice({ tone: "info", text: "Reminder sent." }),
      onError: (error) =>
        setNotice({ tone: "error", text: describeApiError(error) }),
    });
  }

  if (!canAct) {
    return (
      <>
        <ReadOnlyNote>View only. Only admins change invoices.</ReadOnlyNote>
        <SheetPosition index={index} total={total} />
      </>
    );
  }
  if (!invoice) return <SheetPosition index={index} total={total} />;

  const { publicId } = invoice;
  const copy =
    publicId === null ? null : (
      <Button variant="outline" onClick={() => void copyLink(publicId)}>
        <CopyIcon aria-hidden="true" />
        Copy pay link
      </Button>
    );

  return (
    <>
      {invoice.status === "draft" ? (
        <>
          <SheetActions kind="primary">
            <Button onClick={() => onAction("send")}>
              <SendIcon aria-hidden="true" />
              Send
            </Button>
            <Button variant="outline" onClick={() => onAction("edit")}>
              <PencilIcon aria-hidden="true" />
              Edit
            </Button>
          </SheetActions>
          <SheetActions kind="secondary">
            <Button variant="danger" onClick={() => onAction("delete")}>
              <Trash2Icon aria-hidden="true" />
              Delete
            </Button>
          </SheetActions>
        </>
      ) : null}
      {invoice.status === "open" ? (
        <>
          <SheetActions kind="primary">
            <Button onClick={() => onAction("mark_paid")}>
              <CheckIcon aria-hidden="true" />
              Mark paid
            </Button>
            {copy}
            <Button
              variant="outline"
              disabled={remind.isPending}
              onClick={sendReminder}
            >
              <RotateCcwIcon aria-hidden="true" />
              {remind.isPending ? "Sending…" : "Remind"}
            </Button>
            <Button variant="outline" onClick={() => onAction("match")}>
              Match a deposit
            </Button>
          </SheetActions>
          <SheetActions kind="secondary">
            <Button variant="danger" onClick={() => onAction("void")}>
              <BanIcon aria-hidden="true" />
              Void
            </Button>
          </SheetActions>
        </>
      ) : null}
      {invoice.status === "paid" ? (
        <SheetActions kind="primary">{copy}</SheetActions>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            notice.tone === "error"
              ? "basis-full text-error-700"
              : "basis-full text-muted-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}
      <SheetPosition index={index} total={total} />
    </>
  );
}
