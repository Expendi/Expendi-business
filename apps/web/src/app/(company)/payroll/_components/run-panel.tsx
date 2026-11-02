"use client";

import type { FormEvent, JSX } from "react";
import { Fragment, useState } from "react";

import type {
  PayrollPayment,
  PayrollRunDetail,
} from "@expendi-business/shared";
import {
  addPayrollOneOffRequestSchema,
  adjustPayrollPaymentRequestSchema,
  leaveOutOfPayrollRequestSchema,
} from "@expendi-business/shared";

import type { RunPayment } from "./run-payment";
import type { DraftChange } from "~/features/payroll/payroll-payment";
import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
  textButton,
} from "~/components/styles";
import { BillStatusBadge } from "~/features/bills/bill-status";
import { Field, HoldWarning, StatusBadge } from "~/features/payment-ui";
import {
  useChangeDraftRun,
  usePayrollRun,
} from "~/features/payroll/payroll-api";
import { capRoom, RUN_STATUS_LABELS } from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { QueryError } from "./query-error";
import {
  PayrollPaymentReview,
  PayrollResultNotice,
  useRunPayment,
} from "./run-payment";

/**
 * One payroll run (spec §6.21). While it's a draft, admins change one
 * person's pay, leave someone out or add a one-off, each with a reason and
 * for this run only, then Approve & pay all. A failed person is retried
 * alone.
 */
export function RunPanel({
  organizationId,
  runId,
  canAct,
  onClose,
}: {
  organizationId: string;
  runId: string;
  canAct: boolean;
  onClose: () => void;
}): JSX.Element {
  const run = usePayrollRun(organizationId, runId);
  const payment = useRunPayment(organizationId);

  return (
    <section
      aria-label="Payroll run"
      className="space-y-5 rounded-lg border border-stone-200 bg-white p-4"
    >
      {run.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : run.isError ? (
        <QueryError error={run.error} onRetry={() => void run.refetch()} />
      ) : (
        <>
          <RunSummary run={run.data} onClose={onClose} />
          {payment.result ? (
            <PayrollResultNotice
              run={payment.result}
              onDismiss={payment.dismissResult}
            />
          ) : null}
          {canAct ? <PaymentArea run={run.data} payment={payment} /> : null}
          <Payments
            organizationId={organizationId}
            run={run.data}
            canAct={canAct}
            payment={payment}
          />
          {canAct && run.data.status === "draft" && !payment.busy ? (
            <AddOneOff organizationId={organizationId} run={run.data} />
          ) : null}
        </>
      )}
    </section>
  );
}

function RunSummary({
  run,
  onClose,
}: {
  run: PayrollRunDetail;
  onClose: () => void;
}): JSX.Element {
  const status = RUN_STATUS_LABELS[run.status];
  const room = capRoom(run);
  const progress = progressInWords(run);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-stone-500">Payroll run</p>
          <h3 className="mt-1 text-lg font-semibold">
            Pay day {formatIsoDate(run.payDate)}
          </h3>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            KES {formatKesCents(run.totalKes)}
          </p>
          <div className="mt-2">
            <StatusBadge label={status.label} tone={status.tone} />
          </div>
        </div>
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {progress ? <Field label="Payments">{progress}</Field> : null}
        <Field label="People">
          {String(run.people)}
          {run.leftOut > 0 ? `, and ${String(run.leftOut)} left out` : ""}
        </Field>
        <Field label="Cap">
          KES {formatKesCents(run.capKes)}
          <span className="block text-xs text-stone-500">
            Salaries of KES {formatKesCents(run.salariesKes)} plus the company’s
            margin
          </span>
        </Field>
        {room.overCap ? null : (
          <Field label="Room under the cap">
            KES {formatKesCents(room.cents)}
          </Field>
        )}
        {run.approvedAt ? (
          <Field label="Approved">
            {formatNairobiDateTime(run.approvedAt)}
          </Field>
        ) : null}
      </dl>
      {room.overCap ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This run is KES {formatKesCents(room.cents)} over its cap, so it can’t
          be paid as it is. Lower someone’s pay or leave someone out.
        </p>
      ) : null}
    </>
  );
}

/** Approve & pay all, the second confirmation and the review, for admins. */
function PaymentArea({
  run,
  payment,
}: {
  run: PayrollRunDetail;
  payment: RunPayment;
}): JSX.Element | null {
  const { prepared, held } = payment;
  const showApprove = run.status === "draft" && !prepared && !held;
  if (!showApprove && !prepared && !held && !payment.error) return null;

  const approving =
    payment.preparing !== null && payment.preparing.retryBillId === null;
  return (
    <div className="space-y-3">
      <ApprovalPasskeyGate>
        {held ? (
          <HoldWarning
            hold={held.hold}
            onConfirm={payment.confirmHold}
            onCancel={payment.cancel}
          />
        ) : prepared ? (
          <PayrollPaymentReview
            prepared={prepared}
            paying={payment.paying}
            onPay={payment.pay}
            onCancel={payment.cancel}
          />
        ) : showApprove ? (
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <p className="text-sm text-stone-700">
              {run.people === 0
                ? "Nobody is paid in this run."
                : `${String(run.people)} ${run.people === 1 ? "person" : "people"} · KES ${formatKesCents(run.totalKes)}`}
            </p>
            <button
              type="button"
              disabled={
                capRoom(run).overCap || run.people === 0 || payment.busy
              }
              onClick={() =>
                payment.start({
                  runId: run.id,
                  retryBillId: null,
                  secondConfirmation: false,
                })
              }
              className={primaryButton}
            >
              {approving ? "Working out the cost…" : "Approve & pay all"}
            </button>
          </div>
        ) : null}
      </ApprovalPasskeyGate>
      {payment.cancelled ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing was sent.</p>
      ) : null}
      {payment.error ? (
        <p className={alertClass} role="alert">
          {payment.error}
        </p>
      ) : null}
    </div>
  );
}

type Editing =
  | { readonly kind: "adjust"; readonly payment: PayrollPayment }
  | { readonly kind: "leave_out"; readonly payment: PayrollPayment };

function Payments({
  organizationId,
  run,
  canAct,
  payment,
}: {
  organizationId: string;
  run: PayrollRunDetail;
  canAct: boolean;
  payment: RunPayment;
}): JSX.Element {
  const [editing, setEditing] = useState<Editing | null>(null);
  const editable = canAct && run.status === "draft" && !payment.busy;
  const columns = canAct ? 5 : 4;

  if (run.payments.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 p-6 text-sm text-stone-600">
        Nobody is in this run.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Who’s paid
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              KES
            </th>
            <th scope="col" className={headCellClass}>
              Status
            </th>
            <th scope="col" className={headCellClass}>
              Note
            </th>
            {canAct ? (
              <th scope="col" className={headCellClass}>
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {run.payments.map((row) => {
            const leftOut = row.leftOut !== null;
            const open = editing?.payment.billId === row.billId;
            return (
              <Fragment key={row.billId}>
                <tr
                  className={`border-t border-stone-200 align-top ${leftOut ? "bg-stone-50 text-stone-500" : ""}`}
                >
                  <td className={cellClass}>
                    <span className="font-medium">{row.payee.name}</span>
                    <span className="block text-xs text-stone-500">
                      {row.kind === "one_off"
                        ? `One-off: ${row.note ?? ""}`
                        : "Salary"}
                    </span>
                    {row.payee.payoutPhoneConfirmed === false ? (
                      <span className="block text-xs text-amber-800">
                        Hasn’t confirmed their M-Pesa number yet.
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={`${cellClass} text-right whitespace-nowrap tabular-nums ${leftOut ? "line-through" : ""}`}
                  >
                    {formatKesCents(row.amountKes)}
                  </td>
                  <td className={cellClass}>
                    {row.leftOut ? (
                      "Left out"
                    ) : (
                      <BillStatusBadge status={row.status} />
                    )}
                  </td>
                  <td className={`${cellClass} text-stone-600`}>
                    {row.leftOut ? (
                      <>Left out: {row.leftOut.reason}</>
                    ) : row.adjustmentReason ? (
                      <>Changed for this run: {row.adjustmentReason}</>
                    ) : null}
                  </td>
                  {canAct ? (
                    <td className={`${cellClass} whitespace-nowrap`}>
                      {row.status === "payout_failed" ? (
                        <button
                          type="button"
                          disabled={payment.busy}
                          onClick={() =>
                            payment.start({
                              runId: run.id,
                              retryBillId: row.billId,
                              secondConfirmation: false,
                            })
                          }
                          className={secondaryButton}
                        >
                          Retry
                        </button>
                      ) : null}
                      {editable && !leftOut && !open ? (
                        <div className="flex gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setEditing({ kind: "adjust", payment: row })
                            }
                            className={textButton}
                          >
                            Change pay
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setEditing({ kind: "leave_out", payment: row })
                            }
                            className={textButton}
                          >
                            Leave out
                          </button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
                {editing !== null && open && editable ? (
                  <tr className="border-t border-stone-200 bg-stone-50">
                    <td colSpan={columns} className={cellClass}>
                      <DraftChangeForm
                        organizationId={organizationId}
                        runId={run.id}
                        editing={editing}
                        onDone={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Changes one person's pay, or leaves them out, for this run only. */
function DraftChangeForm({
  organizationId,
  runId,
  editing,
  onDone,
}: {
  organizationId: string;
  runId: string;
  editing: Editing;
  onDone: () => void;
}): JSX.Element {
  const change = useChangeDraftRun(organizationId, runId);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const { payment } = editing;
  const adjusting = editing.kind === "adjust";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = adjusting
      ? adjustPayrollPaymentRequestSchema.safeParse({
          amountKes: amount,
          reason,
        })
      : leaveOutOfPayrollRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setTypedError(parsed.error.issues[0]?.message ?? "Check the details.");
      return;
    }
    setTypedError(null);
    const request: DraftChange = adjusting
      ? {
          action: "adjust",
          billId: payment.billId,
          request: { amountKes: amount.trim(), reason },
        }
      : { action: "leave_out", billId: payment.billId, reason };
    change.mutate(request, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={
        adjusting
          ? `Change ${payment.payee.name}’s pay`
          : `Leave ${payment.payee.name} out`
      }
      className="space-y-3"
    >
      <p className="text-sm font-medium">
        {adjusting
          ? `Change ${payment.payee.name}’s pay for this run only; their salary stays as it is.`
          : `Leave ${payment.payee.name} out of this run? Their salary stays, so they’re in the next one.`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {adjusting ? (
          <label className="text-sm">
            Pay in this run (KES)
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder={formatKesCents(payment.amountKes)}
              className={inputClass}
            />
          </label>
        ) : null}
        <label className="text-sm">
          Reason
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            placeholder={
              adjusting ? "e.g. Unpaid leave" : "e.g. Left in October"
            }
            className={inputClass}
          />
        </label>
      </div>
      {typedError ? (
        <p className={alertClass} role="alert">
          {typedError}
        </p>
      ) : null}
      {change.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(change.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={change.isPending}
          className={primaryButton}
        >
          {change.isPending
            ? "Saving…"
            : adjusting
              ? "Change pay"
              : "Leave out"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={change.isPending}
          className={secondaryButton}
        >
          Keep as it is
        </button>
      </div>
    </form>
  );
}

/** An extra payment in this run, e.g. a bonus, to someone already in it. */
function AddOneOff({
  organizationId,
  run,
}: {
  organizationId: string;
  run: PayrollRunDetail;
}): JSX.Element | null {
  const change = useChangeDraftRun(organizationId, run.id);
  const [open, setOpen] = useState(false);
  const [payeeId, setPayeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  const people = run.payments
    .filter((row) => row.leftOut === null)
    .map((row) => row.payee)
    .filter(
      (payee, index, all) =>
        all.findIndex((other) => other.id === payee.id) === index,
    );

  function close() {
    setOpen(false);
    setPayeeId("");
    setAmount("");
    setReason("");
    setTypedError(null);
    change.reset();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = { payeeId, amountKes: amount.trim(), reason };
    const parsed = addPayrollOneOffRequestSchema.safeParse(request);
    if (!parsed.success) {
      setTypedError(parsed.error.issues[0]?.message ?? "Check the details.");
      return;
    }
    setTypedError(null);
    change.mutate({ action: "one_off", request }, { onSuccess: close });
  }

  if (people.length === 0) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={secondaryButton}
      >
        Add a one-off payment
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Add a one-off payment"
      className="space-y-3 rounded-lg border border-stone-200 p-4"
    >
      <div>
        <h4 className="text-sm font-semibold">Add a one-off payment</h4>
        <p className="text-sm text-stone-600">
          For this run only, e.g. a bonus or overtime. It’s paid with everyone
          else.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          Who
          <select
            value={payeeId}
            onChange={(event) => setPayeeId(event.target.value)}
            className={inputClass}
          >
            <option value="">Choose a person</option>
            {people.map((payee) => (
              <option key={payee.id} value={payee.id}>
                {payee.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Amount (KES)
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="5,000.00"
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          What it’s for
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            placeholder="e.g. Overtime in November"
            className={inputClass}
          />
        </label>
      </div>
      {typedError ? (
        <p className={alertClass} role="alert">
          {typedError}
        </p>
      ) : null}
      {change.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(change.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={change.isPending}
          className={primaryButton}
        >
          {change.isPending ? "Adding…" : "Add payment"}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={change.isPending}
          className={secondaryButton}
        >
          Don’t add
        </button>
      </div>
    </form>
  );
}
