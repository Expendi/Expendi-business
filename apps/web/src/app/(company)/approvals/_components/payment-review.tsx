"use client";

import type { JSX } from "react";

import type {
  ClaimApproval,
  ClaimPaymentResult,
} from "@expendi-business/shared";

import { primaryButton, secondaryButton } from "~/components/styles";
import { formatKesCents, formatUsdc } from "~/lib/money";
import { describePaymentResult, previewRows } from "./payment";

/**
 * What the admin confirms with their passkey (spec §6.7 step 2): each
 * claim's payment and the total. A short wallet blocks paying ("Top up KES
 * X", step 4).
 */
export function PaymentReview({
  approval,
  isRetry,
  paying,
  onPay,
  onCancel,
}: {
  approval: ClaimApproval;
  isRetry: boolean;
  paying: boolean;
  onPay: () => void;
  onCancel: () => void;
}): JSX.Element {
  const topUpKes = approval.wallet.topUpKes;
  const count = approval.claims.length;
  return (
    <section
      aria-label="Review the payment"
      className="rounded-lg border border-brand-500 bg-white p-4"
    >
      <h2 className="text-base font-semibold">
        {isRetry
          ? "Retry the payment"
          : `Approve & pay ${String(count)} ${count === 1 ? "claim" : "claims"}`}
      </h2>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {approval.claims.map((preview) => (
          <dl
            key={preview.claimId}
            className="space-y-1 rounded-md border border-stone-200 p-3 text-sm"
          >
            {previewRows(preview).map((row) => (
              <div key={row.label} className="flex justify-between gap-3">
                <dt className="text-stone-600">{row.label}</dt>
                <dd className="text-right font-medium">{row.value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      <dl className="mt-4 grid gap-3 rounded-md bg-stone-50 p-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-stone-600">They receive, in total</dt>
          <dd className="text-base font-semibold">
            KES {formatKesCents(approval.totals.receivesKes)}
          </dd>
        </div>
        <div>
          <dt className="text-stone-600">Total, at most</dt>
          <dd className="text-base font-semibold">
            {formatUsdc(approval.totals.maxDebitUsdc)} USDC
          </dd>
        </div>
        <div>
          <dt className="text-stone-600">In the wallet</dt>
          <dd className="text-base font-semibold">
            {formatUsdc(approval.wallet.availableUsdc)} USDC
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-stone-600">
        Paycrest states its exact fee when each payment is made. What isn’t used
        stays in the wallet. Each claim is paid on its own.
      </p>
      {topUpKes ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-semibold">
            Top up KES {formatKesCents(topUpKes)}
          </span>{" "}
          The wallet doesn’t hold enough USDC for this. Add funds, then review
          it again.
        </p>
      ) : (
        <p className="mt-3 text-sm text-stone-600">
          Your browser asks for your approval passkey. To use the one on your
          phone, choose “use a phone or tablet”.
        </p>
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

export function PaymentResultNotice({
  result,
  onDismiss,
}: {
  result: ClaimPaymentResult;
  onDismiss: () => void;
}): JSX.Element {
  const summary = describePaymentResult(result);
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
      <button
        type="button"
        onClick={onDismiss}
        className={`mt-3 ${secondaryButton}`}
      >
        Done
      </button>
    </section>
  );
}
