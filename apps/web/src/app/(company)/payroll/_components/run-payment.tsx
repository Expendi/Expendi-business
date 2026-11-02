"use client";

import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  PayeeChangeHold,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import { payrollRunPaymentSchema } from "@expendi-business/shared";

import type { PreparedPayrollPayment } from "~/features/payroll/payroll-api";
import type { PayrollPaymentRequest } from "~/features/payroll/payroll-payment";
import { primaryButton, secondaryButton } from "~/components/styles";
import {
  CostChangedError,
  describePaymentError,
  holdFrom,
} from "~/features/bills/bill-payment";
import { payrollKeys } from "~/features/payment-keys";
import { PASSKEY_HINT, PreviewRows, TopUpNotice } from "~/features/payment-ui";
import {
  usePayPayroll,
  usePreparePayrollPayment,
} from "~/features/payroll/payroll-api";
import {
  capRows,
  failedPayments,
  personRows,
  progressInWords,
} from "~/features/payroll/payroll-payment";
import { formatKesCents, formatUsdc } from "~/lib/money";

/**
 * Approve & pay all, or one failed person's retry (spec §6.21): prepare
 * the payouts, a second confirmation if a payee's details changed in the
 * last 24 hours (spec §6.19), the admin's review, one passkey, the result.
 */

interface HeldPayment {
  readonly request: PayrollPaymentRequest;
  readonly hold: PayeeChangeHold;
}

function freshPayment(error: unknown): PayrollRunPayment | null {
  if (!(error instanceof CostChangedError)) return null;
  const fresh: unknown = error.fresh;
  const parsed = payrollRunPaymentSchema.safeParse(fresh);
  return parsed.success ? parsed.data : null;
}

export interface RunPayment {
  readonly prepared: PreparedPayrollPayment | null;
  readonly held: HeldPayment | null;
  readonly result: PayrollRunDetail | null;
  readonly preparing: PayrollPaymentRequest | null;
  readonly paying: boolean;
  /** A payment is being prepared, reviewed or confirmed. */
  readonly busy: boolean;
  readonly cancelled: boolean;
  readonly error: string | null;
  readonly start: (request: PayrollPaymentRequest) => void;
  readonly confirmHold: () => void;
  readonly pay: () => void;
  readonly cancel: () => void;
  readonly dismissResult: () => void;
}

export function useRunPayment(organizationId: string): RunPayment {
  const queryClient = useQueryClient();
  const prepare = usePreparePayrollPayment(organizationId);
  const payment = usePayPayroll(organizationId);
  const [prepared, setPrepared] = useState<PreparedPayrollPayment | null>(null);
  const [held, setHeld] = useState<HeldPayment | null>(null);
  const [result, setResult] = useState<PayrollRunDetail | null>(null);

  function start(request: PayrollPaymentRequest) {
    setResult(null);
    setHeld(null);
    payment.reset();
    prepare.mutate(request, {
      onSuccess: (ready) => setPrepared(ready),
      onError: (error) => {
        const hold = holdFrom(error);
        if (hold && !request.secondConfirmation) setHeld({ request, hold });
      },
    });
  }

  function pay() {
    if (!prepared) return;
    payment.mutate(prepared, {
      onSuccess: (outcome) => {
        if (outcome.status !== "approved") return;
        setResult(outcome.result);
        setPrepared(null);
      },
      onError: (error) => {
        const fresh = freshPayment(error);
        if (fresh) {
          setPrepared({ ...prepared, payment: fresh, preparedAt: Date.now() });
          return;
        }
        // The confirmation may have reached the API; show where things stand.
        setPrepared(null);
        void queryClient.invalidateQueries({
          queryKey: payrollKeys.all(organizationId),
        });
      },
    });
  }

  const error = held
    ? null
    : prepare.isError
      ? describePaymentError(prepare.error)
      : payment.isError
        ? describePaymentError(payment.error)
        : null;

  return {
    prepared,
    held,
    result,
    preparing: prepare.isPending ? prepare.variables : null,
    paying: payment.isPending,
    busy:
      prepare.isPending ||
      payment.isPending ||
      prepared !== null ||
      held !== null,
    cancelled: payment.data?.status === "cancelled" && prepared !== null,
    error,
    start,
    confirmHold: () => {
      if (held) start({ ...held.request, secondConfirmation: true });
    },
    pay,
    cancel: () => {
      payment.reset();
      prepare.reset();
      setPrepared(null);
      setHeld(null);
    },
    dismissResult: () => setResult(null),
  };
}

/** What the admin confirms with their passkey: each person and the run's cap. */
export function PayrollPaymentReview({
  prepared,
  paying,
  onPay,
  onCancel,
}: {
  prepared: PreparedPayrollPayment;
  paying: boolean;
  onPay: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { payment, request } = prepared;
  const topUpKes = payment.wallet.topUpKes;
  const blocked = topUpKes !== null || !payment.cap.withinCap;
  const count = payment.people.length;
  return (
    <section
      aria-label="Review the payment"
      className="rounded-lg border border-brand-500 bg-white p-4"
    >
      <h3 className="text-base font-semibold">
        {request.retryBillId === null
          ? `Approve & pay ${String(count)} ${count === 1 ? "person" : "people"}`
          : "Retry this payment"}
      </h3>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {payment.people.map((person) => (
          <div
            key={person.billId}
            className="space-y-2 rounded-md border border-stone-200 p-3"
          >
            <p className="text-sm font-semibold">{person.payeeName}</p>
            <PreviewRows rows={personRows(person)} />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-1 rounded-md bg-stone-50 p-3">
        <PreviewRows
          rows={[
            ...capRows(payment),
            {
              label: "In the wallet",
              value: `${formatUsdc(payment.wallet.availableUsdc)} USDC`,
            },
          ]}
        />
      </div>
      <p className="mt-3 text-sm text-stone-600">
        Each person is paid on their own: if one payment fails, the others still
        go through. Paycrest states its exact fee when each payment is made;
        what isn’t used stays in the wallet.
      </p>
      {!payment.cap.withinCap ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This is over the run’s cap of KES {formatKesCents(payment.cap.capKes)}
          , so it can’t be paid. Lower someone’s pay, leave someone out, or
          raise the payroll margin.
        </p>
      ) : null}
      {topUpKes ? (
        <TopUpNotice topUpKes={topUpKes} what="this payroll" />
      ) : payment.cap.withinCap ? (
        <p className="mt-3 text-sm text-stone-600">{PASSKEY_HINT}</p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onPay}
          disabled={blocked || paying}
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

/** Where the run stands once Approve & pay all returns. */
export function PayrollResultNotice({
  run,
  onDismiss,
}: {
  run: PayrollRunDetail;
  onDismiss: () => void;
}): JSX.Element {
  const failed = failedPayments(run).length > 0;
  const tone = failed
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-emerald-200 bg-emerald-50 text-emerald-900";
  return (
    <section
      aria-label="Payment result"
      role="status"
      className={`rounded-lg border p-4 text-sm ${tone}`}
    >
      <p className="font-semibold">
        {failed ? "Some payments failed" : "Payroll sent"}
      </p>
      {progressInWords(run) ? (
        <p className="mt-1">{progressInWords(run)}</p>
      ) : null}
      <p className="mt-1">
        {failed
          ? "Nothing reached the people whose payment failed. Retry each of them below; nobody else is paid again."
          : "M-Pesa payments usually arrive within a minute or two; banks can take longer."}
      </p>
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
