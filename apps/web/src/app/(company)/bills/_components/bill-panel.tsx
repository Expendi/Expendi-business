"use client";

import type { JSX } from "react";
import Link from "next/link";
import { useState } from "react";

import type { BillDetail, BillStatus } from "@expendi-business/shared";
import { UNPAID_BILL_STATUSES } from "@expendi-business/shared";

import type { ViewableReceipt } from "~/components/receipt-viewer";
import { ReceiptViewer } from "~/components/receipt-viewer";
import {
  linkClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { isPayable, unpayableReason } from "~/features/bills/bill-payment";
import {
  BillAmount,
  BillStatusBadge,
  headingLabel,
} from "~/features/bills/bill-status";
import { useBill } from "~/features/bills/bills-api";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { Field } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { BillForm } from "./bill-form";
import {
  AddInvoicesForm,
  CancelBillForm,
  MarkPaidOutsideForm,
} from "./bill-settle-forms";

type Mode = "view" | "edit" | "paid_outside" | "cancel" | "invoice";

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

function filesOf(bill: BillDetail): ViewableReceipt[] {
  return bill.files.flatMap((file): ViewableReceipt[] =>
    file.kind === "sms_text"
      ? []
      : [
          {
            id: file.id,
            kind: file.kind,
            contentType: file.contentType,
            url: file.url,
            billRole: file.role,
          },
        ],
  );
}

function BillFields({
  bill,
  rate,
}: {
  bill: BillDetail;
  rate: string | null;
}): JSX.Element {
  const person = (who: BillDetail["markedPaidBy"]) => who?.name ?? who?.email;
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-stone-500">
          {bill.recurringItemId
            ? "Recurring payment"
            : bill.payrollRunId
              ? "Payroll"
              : "Bill"}
          {bill.variable ? " · variable amount" : ""}
        </p>
        <h2 className="mt-1 text-lg font-semibold break-words">
          {bill.payee.name}
        </h2>
        <p className="mt-1 text-xl font-semibold tabular-nums">
          <BillAmount bill={bill} rate={rate} />
        </p>
        <div className="mt-2">
          <BillStatusBadge status={bill.status} />
        </div>
      </div>
      {bill.cancelledReason ? (
        <p className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700">
          Cancelled
          {bill.cancelledBy
            ? ` by ${person(bill.cancelledBy) ?? ""}`
            : ""}: {bill.cancelledReason}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="Due">{formatIsoDate(bill.dueOn)}</Field>
        <Field label="Paid by">
          {bill.payee.method ? METHOD_LABELS[bill.payee.method] : "Not set"}
        </Field>
        <Field label="Overview heading">
          {headingLabel(bill.overviewHeading)}
        </Field>
        <Field label="Category">{bill.category.name}</Field>
        {bill.reference ? (
          <Field label="Reference">{bill.reference}</Field>
        ) : null}
        {bill.paidOn ? (
          <Field label="Paid on">{formatIsoDate(bill.paidOn)}</Field>
        ) : null}
        {bill.markedPaidBy ? (
          <Field label="Marked paid by">{person(bill.markedPaidBy)}</Field>
        ) : null}
        {bill.paidOutsideNote ? (
          <Field label="Payment note">{bill.paidOutsideNote}</Field>
        ) : null}
        {bill.adjustmentReason ? (
          <Field label="Why the amount changed">{bill.adjustmentReason}</Field>
        ) : null}
        {bill.cancelledAt ? (
          <Field label="Cancelled">{formatNairobiDate(bill.cancelledAt)}</Field>
        ) : null}
      </dl>
      {bill.notes ? (
        <p className="text-sm whitespace-pre-wrap text-stone-700">
          {bill.notes}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One bill with its invoices beside it. Admins act on an unpaid bill:
 * pay or retry it, edit it (a variable bill's amount goes in here), add
 * an invoice, mark it paid outside Expendi or cancel it.
 */
export function BillPanel({
  organizationId,
  billId,
  canAct,
  rate,
  paymentBusy,
  onPay,
  onClose,
}: {
  organizationId: string;
  billId: string;
  canAct: boolean;
  rate: string | null;
  /** A payment is being prepared or reviewed, so Pay waits. */
  paymentBusy: boolean;
  onPay: (bill: BillDetail) => void;
  onClose: () => void;
}): JSX.Element {
  const detail = useBill(organizationId, billId);
  const [mode, setMode] = useState<Mode>("view");

  return (
    <section
      aria-label="Bill"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="mb-3 flex justify-end">
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      {detail.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : detail.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(detail.error)}</p>
          <button
            type="button"
            onClick={() => void detail.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : mode === "edit" ? (
        <BillForm
          organizationId={organizationId}
          bill={detail.data}
          onSaved={() => setMode("view")}
          onCancel={() => setMode("view")}
        />
      ) : (
        <div className="grid gap-6 2xl:grid-cols-2">
          <div className="space-y-4">
            <BillFields bill={detail.data} rate={rate} />
            {canAct ? (
              <BillActions
                organizationId={organizationId}
                bill={detail.data}
                mode={mode}
                paymentBusy={paymentBusy}
                onMode={setMode}
                onPay={() => onPay(detail.data)}
              />
            ) : null}
          </div>
          <ReceiptViewer receipts={filesOf(detail.data)} />
        </div>
      )}
    </section>
  );
}

function BillActions({
  organizationId,
  bill,
  mode,
  paymentBusy,
  onMode,
  onPay,
}: {
  organizationId: string;
  bill: BillDetail;
  mode: Mode;
  paymentBusy: boolean;
  onMode: (mode: Mode) => void;
  onPay: () => void;
}): JSX.Element | null {
  const back = () => onMode("view");
  if (mode === "paid_outside") {
    return (
      <MarkPaidOutsideForm
        organizationId={organizationId}
        bill={bill}
        onDone={back}
      />
    );
  }
  if (mode === "cancel") {
    return (
      <CancelBillForm
        organizationId={organizationId}
        bill={bill}
        onDone={back}
      />
    );
  }
  if (mode === "invoice") {
    return (
      <AddInvoicesForm
        organizationId={organizationId}
        bill={bill}
        onDone={back}
      />
    );
  }
  if (bill.payrollRunId !== null) {
    return (
      <p className="text-sm text-stone-600">
        Paid with its payroll run, under{" "}
        <Link href="/payroll" className={linkClass}>
          Payroll
        </Link>
        .
      </p>
    );
  }
  if (!isUnpaid(bill.status)) return null;

  const payable = isPayable(bill);
  const reason = unpayableReason(bill);
  const needsAmount =
    bill.currency === "usd"
      ? bill.amountUsdc === null
      : bill.amountKes === null;
  return (
    <div className="space-y-3">
      {reason ? <p className="text-sm text-stone-600">{reason}</p> : null}
      <div className="flex flex-wrap gap-3">
        {payable ? (
          <button
            type="button"
            disabled={paymentBusy}
            onClick={onPay}
            className={primaryButton}
          >
            {bill.status === "payout_failed" ? "Retry payment" : "Pay"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onMode("edit")}
          className={payable ? secondaryButton : primaryButton}
        >
          {needsAmount ? "Enter the amount" : "Edit bill"}
        </button>
        <button
          type="button"
          onClick={() => onMode("invoice")}
          className={secondaryButton}
        >
          Add invoice
        </button>
        {needsAmount ? null : (
          <button
            type="button"
            onClick={() => onMode("paid_outside")}
            className={secondaryButton}
          >
            Mark paid outside
          </button>
        )}
        <button
          type="button"
          onClick={() => onMode("cancel")}
          className={secondaryButton}
        >
          Cancel bill
        </button>
      </div>
    </div>
  );
}
