"use client";

import type { JSX } from "react";
import {
  ChevronDownIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type {
  BillPayment,
  BillPaymentPreview,
  BillPaymentResult,
  PayeeChangeHold,
} from "@expendi-business/shared";

import type { PreviewRow } from "~/features/bills/bill-payment";
import { textLinkClass } from "~/components/data/actions";
import { Banner } from "~/components/data/banner";
import { EntityMark, RowCheckbox } from "~/components/data/cells";
import { Callout } from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { Button } from "~/components/ui/button";
import {
  billPreviewRows,
  billTotalRows,
  describeBillPaymentResult,
  holdWarning,
} from "~/features/bills/bill-payment";
import { PASSKEY_HINT } from "~/features/payment-ui";
import { formatKes } from "~/lib/money";
import { Note } from "./note";
import { SheetFooterPortal } from "./sheet-footer";

export function paymentTitle(isRetry: boolean, count: number): string {
  if (isRetry) return "Retry the payment";
  return count === 1 ? "Pay bill" : `Pay ${String(count)} bills`;
}

/**
 * A payee's details changed in the last 24 hours (spec §6.19, §7.8): the
 * admin confirms they checked them before the payment is prepared again
 * with `secondConfirmation`.
 */
export function PaymentHold({
  hold,
  preparing,
  footerSlot,
  onConfirm,
  onCancel,
}: {
  hold: PayeeChangeHold;
  preparing: boolean;
  footerSlot: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [checked, setChecked] = useState(false);
  const warning = holdWarning(hold);
  return (
    <>
      <div role="alert">
        <Callout tone="warn" icon={ShieldAlertIcon}>
          <p>{warning.body}</p>
        </Callout>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <RowCheckbox
          className="mt-px"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span className="text-sm font-(--w-ui) text-foreground">
          {warning.confirmLabel}
        </span>
      </label>
      <SheetFooterPortal slot={footerSlot}>
        <Button disabled={!checked || preparing} onClick={onConfirm}>
          {preparing ? "Working out the cost…" : "Continue"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooterPortal>
    </>
  );
}

function PreviewList({ rows }: { rows: readonly PreviewRow[] }): JSX.Element {
  return (
    <dl className="flex flex-col px-3 pb-3 pl-14 max-[600px]:pl-3">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[11rem_minmax(0,1fr)] gap-3 border-t border-border py-[9px] max-[600px]:grid-cols-[minmax(0,1fr)] max-[600px]:gap-0.5"
        >
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="[overflow-wrap:anywhere] tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewAmount({
  preview,
}: {
  preview: BillPaymentPreview;
}): JSX.Element {
  return preview.receivesUsdc !== null ? (
    <Money amount={preview.receivesUsdc} currency="USDC" />
  ) : (
    <Money amount={preview.receivesKes ?? "0"} currency="KES" />
  );
}

/**
 * What the admin confirms with one passkey (spec §6.20): each bill's
 * payment and the total. A short wallet blocks paying ("Top up KES X").
 */
export function PaymentReview({
  payment,
  paying,
  costChanged,
  cancelled,
  footerSlot,
  onPay,
  onCancel,
}: {
  payment: BillPayment;
  paying: boolean;
  /** The cost moved between the review and the passkey: this is the new one. */
  costChanged: boolean;
  /** The admin closed the passkey prompt. */
  cancelled: boolean;
  footerSlot: HTMLElement | null;
  onPay: () => void;
  onCancel: () => void;
}): JSX.Element {
  const topUpKes = payment.wallet.topUpKes;
  const openAll = payment.bills.length <= 3;
  return (
    <>
      {costChanged ? (
        <div role="alert">
          <Callout tone="warn">
            <p>
              The cost changed since you reviewed it. Nothing was sent. Review
              it again.
            </p>
          </Callout>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {payment.bills.map((preview) => (
          <details
            key={preview.billId}
            open={openAll}
            className="group/preview rounded-control border border-border"
          >
            <summary className="grid cursor-pointer list-none grid-cols-[32px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-control px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <EntityMark name={preview.payeeName} />
              <span className="min-w-0">
                <span className="block truncate font-(--w-name)">
                  {preview.payeeName}
                </span>
                <span className="block truncate text-xs leading-4 text-muted-foreground">
                  {preview.paidTo.label}
                </span>
              </span>
              <span className="text-right font-(--w-amount) whitespace-nowrap">
                <PreviewAmount preview={preview} />
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground transition-transform duration-200 ease-out-expo group-open/preview:rotate-180"
              />
            </summary>
            <PreviewList rows={billPreviewRows(preview)} />
          </details>
        ))}
      </div>
      <dl
        aria-label="Total"
        className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-control bg-muted/60 px-4 py-3.5 max-[600px]:grid-cols-1"
      >
        {billTotalRows(payment).map((row) => (
          <div key={row.label}>
            <dt className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
              {row.label}
            </dt>
            <dd className="mt-1 text-base leading-6 font-(--w-amount) tabular-nums">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <Note>
        One passkey confirmation pays them all, each on its own: if one fails,
        the others still go through. Paycrest states its exact fee when each
        payment is made; what isn’t used stays in the wallet.
      </Note>
      {topUpKes ? (
        <Callout tone="warn" title={`Top up KES ${formatKes(topUpKes)}`}>
          <p>
            The wallet doesn’t hold enough USDC for these payments. Add funds,
            then review it again.{" "}
            <Link href="/wallet" className={textLinkClass}>
              Go to Accounts
            </Link>
          </p>
        </Callout>
      ) : (
        <Note icon={KeyRoundIcon}>{PASSKEY_HINT}</Note>
      )}
      {cancelled ? <Note>Cancelled. Nothing was sent.</Note> : null}
      <SheetFooterPortal slot={footerSlot}>
        <Button disabled={topUpKes !== null || paying} onClick={onPay}>
          {paying ? (
            "Waiting for your passkey…"
          ) : (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Pay with passkey
            </>
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={paying}>
          Cancel
        </Button>
      </SheetFooterPortal>
    </>
  );
}

/** How a payment went, with a retry for the one that failed. */
export function PaymentResultBanner({
  result,
  showBeingPaid,
  onRetry,
  onSeeBeingPaid,
  onDismiss,
}: {
  result: BillPaymentResult;
  /** Offer the Being paid tab, when that's not the one showing. */
  showBeingPaid: boolean;
  onRetry: (billId: string) => void;
  onSeeBeingPaid: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const summary = describeBillPaymentResult(result);
  const [onlyFailed] =
    summary.failedBillIds.length === 1 ? summary.failedBillIds : [];
  const warn = summary.outcome === "failed" || summary.outcome === "review";
  return (
    <Banner
      tone={warn ? "warn" : "success"}
      role="status"
      aria-label="Payment result"
      title={summary.title}
      actions={
        <>
          {onlyFailed ? (
            <Button size="md" onClick={() => onRetry(onlyFailed)}>
              <RotateCcwIcon aria-hidden="true" />
              Retry the failed payment
            </Button>
          ) : null}
          {summary.outcome === "sent" && showBeingPaid ? (
            <Button variant="outline" size="md" onClick={onSeeBeingPaid}>
              See Being paid
            </Button>
          ) : null}
          <Button variant="outline" size="md" onClick={onDismiss}>
            Done
          </Button>
        </>
      }
    >
      <p>{summary.body}</p>
      {summary.failureReason ? <p>{summary.failureReason}</p> : null}
    </Banner>
  );
}
