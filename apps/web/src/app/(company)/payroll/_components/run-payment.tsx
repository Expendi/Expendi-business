"use client";

import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type {
  PayeeChangeHold,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import { payrollRunPaymentSchema } from "@expendi-business/shared";

import type { PreparedPayrollPayment } from "~/features/payroll/payroll-api";
import type { PayrollPaymentRequest } from "~/features/payroll/payroll-payment";
import { textLinkClass } from "~/components/data/actions";
import { Banner } from "~/components/data/banner";
import { EntityMark } from "~/components/data/cells";
import {
  Callout,
  DetailItem,
  DetailList,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { Button } from "~/components/ui/button";
import {
  CostChangedError,
  describePaymentError,
  holdFrom,
} from "~/features/bills/bill-payment";
import { payrollKeys } from "~/features/payment-keys";
import { PASSKEY_HINT, SheetNote } from "~/features/payment-ui";
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
import { formatKes, formatUsdc } from "~/lib/money";

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

/**
 * What the admin confirms with their passkey: each person (open when
 * there are three or fewer), the run's cap and the wallet.
 */
export function PayrollReview({
  prepared,
  error,
  cancelled,
}: {
  prepared: PreparedPayrollPayment;
  /** e.g. the cost changed since the review; nothing was sent. */
  error: string | null;
  cancelled: boolean;
}): JSX.Element {
  const { payment } = prepared;
  const topUpKes = payment.wallet.topUpKes;
  const totals = [
    ...capRows(payment),
    {
      label: "In the wallet",
      value: `${formatUsdc(payment.wallet.availableUsdc)} USDC`,
    },
  ];
  return (
    <>
      {error ? (
        <div role="alert">
          <Callout tone="warn">
            <p>{error}</p>
          </Callout>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {payment.people.map((person) => (
          <details
            key={person.billId}
            open={payment.people.length <= 3}
            className="group rounded-lg border border-border"
          >
            <summary className="grid cursor-pointer list-none grid-cols-[32px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-lg px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <EntityMark name={person.payeeName} kind="person" />
              <span className="min-w-0">
                <span className="block truncate font-(--w-name)">
                  {person.payeeName}
                </span>
                <span className="block truncate text-xs leading-4 text-muted-foreground">
                  {person.paidTo.label}
                </span>
              </span>
              <span className="text-right font-(--w-amount)">
                <Money amount={person.receivesKes} currency="KES" />
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <div className="border-t border-border px-3 pt-2 pb-3 pl-14 max-[600px]:pl-3">
              <DetailList>
                {personRows(person).map((row) => (
                  <DetailItem key={row.label} label={row.label}>
                    {row.value}
                  </DetailItem>
                ))}
              </DetailList>
            </div>
          </details>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/60 px-4 py-3.5 max-[600px]:grid-cols-1">
        {totals.map((row) => (
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
      <SheetNote>
        Each person is paid on their own: if one payment fails, the others still
        go through. The exact fee is known when each cash-out is sent; what
        isn’t used stays in the wallet.
      </SheetNote>
      {payment.cap.withinCap ? null : (
        <div role="alert">
          <Callout tone="warn">
            <p className="tabular-nums">
              This is over the run’s cap of KES {formatKes(payment.cap.capKes)},
              so it can’t be paid. Lower someone’s pay, leave someone out, or
              raise the payroll margin.
            </p>
          </Callout>
        </div>
      )}
      {topUpKes !== null ? (
        <Callout
          tone="warn"
          title={
            <>
              Top up <Money amount={topUpKes} currency="KES" />
            </>
          }
        >
          <p>
            The wallet doesn’t hold enough USDC for this payroll. Add funds,
            then review it again.{" "}
            <Link href="/wallet" className={textLinkClass}>
              Go to Accounts
            </Link>
          </p>
        </Callout>
      ) : payment.cap.withinCap ? (
        <SheetNote icon={KeyRoundIcon}>{PASSKEY_HINT}</SheetNote>
      ) : null}
      {cancelled ? <SheetNote>Cancelled. Nothing was sent.</SheetNote> : null}
    </>
  );
}

/** Whether the review can go to the passkey: within the cap and funded. */
export function canConfirm(prepared: PreparedPayrollPayment): boolean {
  return (
    prepared.payment.wallet.topUpKes === null && prepared.payment.cap.withinCap
  );
}

/** Where the run stands once Approve & pay all, or a retry, returns. */
export function PayrollResult({
  run,
  onDismiss,
}: {
  run: PayrollRunDetail;
  onDismiss: () => void;
}): JSX.Element {
  const failed = failedPayments(run).length > 0;
  const progress = progressInWords(run);
  return (
    <Banner
      role="status"
      aria-label="Payment result"
      tone={failed ? "warn" : "success"}
      title={failed ? "Some payments failed" : "Payroll sent"}
      actions={
        <Button variant="outline" size="md" onClick={onDismiss}>
          Done
        </Button>
      }
    >
      {progress ? <p className="tabular-nums">{progress}</p> : null}
      <p>
        {failed
          ? "Nothing reached the people whose payment failed. Retry each of them below; nobody else is paid again."
          : "M-Pesa payments usually arrive within a minute or two; banks can take longer."}
      </p>
    </Banner>
  );
}
