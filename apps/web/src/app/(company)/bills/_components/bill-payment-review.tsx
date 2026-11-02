"use client";

import type { JSX } from "react";

import type { BillPayment, BillPaymentResult } from "@expendi-business/shared";

import { primaryButton, secondaryButton } from "~/components/styles";
import {
  billPreviewRows,
  billTotalRows,
  describeBillPaymentResult,
} from "~/features/bills/bill-payment";
import { PASSKEY_HINT, PreviewRows, TopUpNotice } from "~/features/payment-ui";

/**
 * What the admin confirms with one passkey (spec §6.20): each bill's
 * payment and the total. A short wallet blocks paying ("Top up KES X").
 */
export function BillPaymentReview({
  payment,
  isRetry,
  paying,
  onPay,
  onCancel,
}: {
  payment: BillPayment;
  isRetry: boolean;
  paying: boolean;
  onPay: () => void;
  onCancel: () => void;
}): JSX.Element {
  const topUpKes = payment.wallet.topUpKes;
  const count = payment.bills.length;
  return (
    <section
      aria-label="Review the payment"
      ref={(node) => node?.scrollIntoView({ block: "nearest" })}
      className="rounded-lg border border-brand-500 bg-white p-4"
    >
      <h2 className="text-base font-semibold">
        {isRetry
          ? "Retry the payment"
          : count === 1
            ? "Pay bill"
            : `Pay ${String(count)} bills`}
      </h2>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {payment.bills.map((preview) => (
          <div
            key={preview.billId}
            className="rounded-md border border-stone-200 p-3"
          >
            <p className="mb-2 text-sm font-semibold">{preview.payeeName}</p>
            <PreviewRows rows={billPreviewRows(preview)} />
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-md bg-stone-50 p-3">
        <p className="mb-2 text-sm font-semibold">Total</p>
        <PreviewRows rows={billTotalRows(payment)} />
      </div>
      <p className="mt-3 text-sm text-stone-600">
        One passkey confirmation pays them all, each on its own: if one fails,
        the others still go through. Paycrest states its exact fee when each
        payment is made; what isn’t used stays in the wallet.
      </p>
      {topUpKes ? (
        <TopUpNotice topUpKes={topUpKes} what="these payments" />
      ) : (
        <p className="mt-3 text-sm text-stone-600">{PASSKEY_HINT}</p>
      )}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onPay}
          disabled={topUpKes !== null || paying}
          className={primaryButton}
        >
          {paying ? "Waiting for your passkey…" : "Pay with passkey"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={paying}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

export function BillPaymentResultNotice({
  result,
  onRetry,
  onDismiss,
}: {
  result: BillPaymentResult;
  onRetry: (billId: string) => void;
  onDismiss: () => void;
}): JSX.Element {
  const summary = describeBillPaymentResult(result);
  const [onlyFailed] =
    summary.failedBillIds.length === 1 ? summary.failedBillIds : [];
  const tone =
    summary.outcome === "failed" || summary.outcome === "review"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return (
    <section
      aria-label="Payment result"
      role="status"
      className={`rounded-lg border p-4 text-sm ${tone}`}
    >
      <p className="font-semibold">{summary.title}</p>
      <p className="mt-1">{summary.body}</p>
      {summary.failureReason ? (
        <p className="mt-1">{summary.failureReason}</p>
      ) : null}
      <div className="mt-3 flex gap-3">
        {onlyFailed ? (
          <button
            type="button"
            onClick={() => onRetry(onlyFailed)}
            className={primaryButton}
          >
            Retry the failed payment
          </button>
        ) : null}
        <button type="button" onClick={onDismiss} className={secondaryButton}>
          Done
        </button>
      </div>
    </section>
  );
}
