"use client";

import type { JSX } from "react";
import { cn } from "cn";
import {
  CheckIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import type {
  PayrollPayment,
  PayrollRun,
  PayrollRunDetail,
} from "@expendi-business/shared";
import {
  addPayrollOneOffRequestSchema,
  adjustPayrollPaymentRequestSchema,
  leaveOutOfPayrollRequestSchema,
} from "@expendi-business/shared";

import type { RunPayment } from "./run-payment";
import type { FieldErrors } from "./sheet-parts";
import type { PasskeyState } from "~/features/payment-ui";
import { TreasuryOfferButton } from "~/app/(company)/wallet/_components/treasury-offer";
import { TextLinkButton } from "~/components/data/actions";
import { EntityMark, RowCheckbox } from "~/components/data/cells";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { ReceiptCodes } from "~/components/data/payment-receipts";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { holdWarning } from "~/features/bills/bill-payment";
import { receiptRows } from "~/features/payment-receipts";
import {
  FieldRow,
  FormField,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import {
  useChangeDraftRun,
  usePayrollRun,
} from "~/features/payroll/payroll-api";
import {
  capRoom,
  DRAFT_TIMING,
  OVERVIEW_HEADING,
  paymentStatusBadge,
  RUN_STATUS_LABELS,
  UNCONFIRMED_NUMBER,
  ZOHO_NOTE,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatKes, formatKesCents } from "~/lib/money";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  canConfirm,
  PayrollResult,
  PayrollReview,
  useRunPayment,
} from "./run-payment";
import { errorsByField, focusFirstError } from "./sheet-parts";

type RunMode =
  | { readonly kind: "detail" }
  | { readonly kind: "adjust"; readonly billId: string }
  | { readonly kind: "leave_out"; readonly billId: string }
  | { readonly kind: "one_off" };

interface SheetState {
  readonly runId: string;
  readonly mode: RunMode;
  /** What the last change did, e.g. "Pay changed for this run." */
  readonly notice: string | null;
}

interface ChangeDraft {
  readonly amount: string;
  readonly reason: string;
  readonly payeeId: string;
}

const DETAIL: RunMode = { kind: "detail" };
const BLANK: ChangeDraft = { amount: "", reason: "", payeeId: "" };
const FORM_ID = "payroll-run-form";
const FIELD_IDS = {
  payeeId: "run-who",
  amountKes: "run-amount",
  reason: "run-reason",
} as const;

/** Left out last, then A to Z, each salary before that person's one-offs. */
function sortPayments(payments: readonly PayrollPayment[]): PayrollPayment[] {
  return [...payments].sort(
    (a, b) =>
      Number(a.leftOut !== null) - Number(b.leftOut !== null) ||
      a.payee.name.localeCompare(b.payee.name) ||
      Number(a.kind === "one_off") - Number(b.kind === "one_off"),
  );
}

/** Everyone still in the run, once each, for a one-off payment. */
function peopleInRun(payments: readonly PayrollPayment[]) {
  const people = new Map(
    payments
      .filter((row) => row.leftOut === null)
      .map((row) => [row.payee.id, row.payee.name]),
  );
  return [...people]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One payroll run in the side sheet (spec §6.21). While it's a draft,
 * admins change one person's pay, leave someone out or add a one-off,
 * each with a reason and for this run only, then Approve & pay all with
 * one passkey. A failed person is retried alone.
 */
export function RunSheet({
  organizationId,
  run: listed,
  index,
  total,
  onStep,
  onClose,
  canAct,
  passkey,
}: {
  organizationId: string;
  /** The run as the list has it, shown while its payments load. */
  run: PayrollRun;
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  canAct: boolean;
  passkey: PasskeyState;
}): JSX.Element {
  const detail = usePayrollRun(organizationId, listed.id);
  const payment = useRunPayment(organizationId);
  const change = useChangeDraftRun(organizationId, listed.id);
  const [state, setState] = useState<SheetState>({
    runId: listed.id,
    mode: DETAIL,
    notice: null,
  });
  const [draft, setDraft] = useState<ChangeDraft>(BLANK);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [holdChecked, setHoldChecked] = useState(false);
  const [holdShown, setHoldShown] = useState<RunPayment["held"]>(null);

  const current: SheetState =
    state.runId === listed.id
      ? state
      : { runId: listed.id, mode: DETAIL, notice: null };
  const run: PayrollRun = detail.data ?? listed;
  const payments = detail.data?.payments ?? null;
  const mode = current.mode;
  const billId =
    mode.kind === "adjust" || mode.kind === "leave_out" ? mode.billId : null;
  const editing = payments?.find((row) => row.billId === billId) ?? null;
  const confirmingHold =
    payment.preparing?.secondConfirmation === true &&
    payment.preparing.runId === run.id;
  const held =
    payment.held?.request.runId === run.id
      ? payment.held
      : confirmingHold
        ? holdShown
        : null;
  const prepared =
    held === null && payment.prepared?.request.runId === run.id
      ? payment.prepared
      : null;
  const form: "adjust" | "leave_out" | "one_off" | null =
    mode.kind === "one_off"
      ? "one_off"
      : editing !== null && mode.kind !== "detail"
        ? mode.kind
        : null;

  const isDraft = run.status === "draft";
  const room = capRoom(run);
  const dateText = formatIsoDate(run.payDate);

  function openForm(next: RunMode) {
    change.reset();
    setDraft(BLANK);
    setErrors({});
    setState({ runId: run.id, mode: next, notice: null });
  }

  function backToDetail(notice: string | null = null) {
    setState({ runId: run.id, mode: DETAIL, notice });
  }

  function startPayment(retryBillId: string | null) {
    setHoldChecked(false);
    backToDetail();
    payment.start({ runId: run.id, retryBillId, secondConfirmation: false });
  }

  function invalid(found: FieldErrors) {
    setErrors(found);
    focusFirstError(found, FIELD_IDS);
  }

  function submitChange() {
    if (form === "adjust" && editing) {
      const parsed = adjustPayrollPaymentRequestSchema.safeParse({
        amountKes: draft.amount,
        reason: draft.reason,
      });
      if (!parsed.success) return invalid(errorsByField(parsed.error.issues));
      setErrors({});
      change.mutate(
        {
          action: "adjust",
          billId: editing.billId,
          request: { amountKes: draft.amount.trim(), reason: draft.reason },
        },
        { onSuccess: () => backToDetail("Pay changed for this run.") },
      );
    } else if (form === "leave_out" && editing) {
      const parsed = leaveOutOfPayrollRequestSchema.safeParse({
        reason: draft.reason,
      });
      if (!parsed.success) return invalid(errorsByField(parsed.error.issues));
      setErrors({});
      change.mutate(
        { action: "leave_out", billId: editing.billId, reason: draft.reason },
        { onSuccess: () => backToDetail("Left out of this run.") },
      );
    } else if (form === "one_off") {
      const request = {
        payeeId: draft.payeeId,
        amountKes: draft.amount.trim(),
        reason: draft.reason,
      };
      const parsed = addPayrollOneOffRequestSchema.safeParse(request);
      if (!parsed.success) return invalid(errorsByField(parsed.error.issues));
      setErrors({});
      change.mutate(
        { action: "one_off", request },
        { onSuccess: () => backToDetail("One-off payment added.") },
      );
    }
  }

  const position = <SheetPosition index={index} total={total} />;
  const formFooter = (label: string, busyLabel: string, cancel: string) => (
    <SheetActions kind="primary">
      <Button type="submit" form={FORM_ID} disabled={change.isPending}>
        {change.isPending ? busyLabel : label}
      </Button>
      <Button
        variant="outline"
        disabled={change.isPending}
        onClick={() => backToDetail()}
      >
        {cancel}
      </Button>
    </SheetActions>
  );

  if (held) {
    const warning = holdWarning(held.hold);
    return (
      <DetailSheet
        open
        onClose={onClose}
        eyebrow={`Pay day ${dateText}`}
        title={warning.title}
        stepKey={`${run.id}-hold`}
        footer={
          <SheetActions kind="primary">
            <Button
              disabled={!holdChecked || confirmingHold}
              onClick={() => {
                setHoldShown(held);
                payment.confirmHold();
              }}
            >
              {confirmingHold ? "Working out the cost…" : "Continue"}
            </Button>
            <Button
              variant="outline"
              disabled={confirmingHold}
              onClick={payment.cancel}
            >
              Cancel
            </Button>
          </SheetActions>
        }
      >
        <div role="alert">
          <Callout tone="warn" icon={ShieldAlertIcon}>
            <p>{warning.body}</p>
          </Callout>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <RowCheckbox
            className="mt-px"
            checked={holdChecked}
            onChange={(event) => setHoldChecked(event.target.checked)}
          />
          <span className="font-(--w-ui) text-foreground">
            {warning.confirmLabel}
          </span>
        </label>
      </DetailSheet>
    );
  }

  if (prepared) {
    const count = prepared.payment.people.length;
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!payment.paying}
        eyebrow={`Pay day ${dateText}`}
        title={
          prepared.request.retryBillId === null
            ? `Approve & pay ${String(count)} ${count === 1 ? "person" : "people"}`
            : "Retry this payment"
        }
        stepKey={`${run.id}-review`}
        footer={
          <SheetActions kind="primary">
            <Button
              disabled={!canConfirm(prepared) || payment.paying}
              onClick={payment.pay}
            >
              {payment.paying ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Pay with passkey
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={payment.paying}
              onClick={payment.cancel}
            >
              Cancel
            </Button>
          </SheetActions>
        }
      >
        <PayrollReview
          prepared={prepared}
          error={payment.error}
          errorAction={<TreasuryOfferButton error={payment.failure} />}
          cancelled={payment.cancelled}
        />
      </DetailSheet>
    );
  }

  if (form) {
    const name = editing?.payee.name ?? "";
    const forms = {
      adjust: {
        title: `Change ${name}’s pay`,
        footer: formFooter("Change pay", "Saving…", "Keep as it is"),
      },
      leave_out: {
        title: `Leave ${name} out`,
        footer: formFooter("Leave out", "Saving…", "Keep as it is"),
      },
      one_off: {
        title: "Add a one-off payment",
        footer: formFooter("Add payment", "Adding…", "Don’t add"),
      },
    } as const;
    return (
      <DetailSheet
        open
        onClose={onClose}
        dismissible={!change.isPending}
        eyebrow={`Pay day ${dateText}`}
        title={forms[form].title}
        stepKey={`${run.id}-${form}`}
        footer={forms[form].footer}
      >
        <SheetForm
          id={FORM_ID}
          label={forms[form].title}
          onSubmit={submitChange}
        >
          {form === "adjust" && editing ? (
            <>
              <p className="font-(--w-ui)">
                Change {name}’s pay for this run only; their salary stays as it
                is.
              </p>
              <FieldRow>
                <FormField
                  id={FIELD_IDS.amountKes}
                  label="Pay in this run (KES)"
                  error={errors.amountKes}
                >
                  <Input
                    id={FIELD_IDS.amountKes}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={formatKesCents(editing.amountKes)}
                    value={draft.amount}
                    aria-invalid={errors.amountKes ? true : undefined}
                    onChange={(event) =>
                      setDraft({ ...draft, amount: event.target.value })
                    }
                  />
                </FormField>
                <ReasonField
                  draft={draft}
                  onDraft={setDraft}
                  error={errors.reason}
                  placeholder="e.g. Unpaid leave"
                />
              </FieldRow>
            </>
          ) : form === "leave_out" ? (
            <>
              <p className="font-(--w-ui)">
                Leave {name} out of this run? Their salary stays, so they’re in
                the next one.
              </p>
              <ReasonField
                draft={draft}
                onDraft={setDraft}
                error={errors.reason}
                placeholder="e.g. Left in October"
              />
            </>
          ) : (
            <>
              <SheetNote>
                For this run only, e.g. a bonus or overtime. It’s paid with
                everyone else.
              </SheetNote>
              <FormField
                id={FIELD_IDS.payeeId}
                label="Who"
                error={errors.payeeId}
              >
                <NativeSelect
                  id={FIELD_IDS.payeeId}
                  className="w-full"
                  value={draft.payeeId}
                  aria-invalid={errors.payeeId ? true : undefined}
                  onChange={(event) =>
                    setDraft({ ...draft, payeeId: event.target.value })
                  }
                >
                  <NativeSelectOption value="">
                    Choose a person
                  </NativeSelectOption>
                  {peopleInRun(payments ?? []).map((person) => (
                    <NativeSelectOption key={person.id} value={person.id}>
                      {person.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
              <FieldRow>
                <FormField
                  id={FIELD_IDS.amountKes}
                  label="Amount (KES)"
                  error={errors.amountKes}
                >
                  <Input
                    id={FIELD_IDS.amountKes}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="5,000.00"
                    value={draft.amount}
                    aria-invalid={errors.amountKes ? true : undefined}
                    onChange={(event) =>
                      setDraft({ ...draft, amount: event.target.value })
                    }
                  />
                </FormField>
                <ReasonField
                  draft={draft}
                  onDraft={setDraft}
                  error={errors.reason}
                  label="What it’s for"
                  placeholder="e.g. Overtime in November"
                />
              </FieldRow>
            </>
          )}
          {change.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(change.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      </DetailSheet>
    );
  }

  const status = RUN_STATUS_LABELS[run.status];
  const progress = progressInWords(run);
  const approving =
    payment.preparing?.runId === run.id &&
    payment.preparing.retryBillId === null;
  const canPay = passkey === "ready";

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!payment.paying}
      eyebrow="Payroll run"
      title={<span className="tabular-nums">Pay day {dateText}</span>}
      stepKey={run.id}
      headerExtra={
        <>
          <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
            <Money amount={run.totalKes} currency="KES" />
          </p>
          <StatusBadge tone={status.tone} className="mt-2">
            {status.label}
          </StatusBadge>
        </>
      }
      stepper={{
        index,
        total,
        onStep,
        previousLabel: "Previous run",
        nextLabel: "Next run",
      }}
      footer={
        !canAct ? (
          <>
            <ReadOnlyNote>
              View only. Only admins change or pay payroll.
            </ReadOnlyNote>
            {position}
          </>
        ) : !isDraft ? (
          position
        ) : (
          <>
            <SheetActions kind="primary">
              {canPay ? (
                <Button
                  disabled={room.overCap || run.people === 0 || payment.busy}
                  onClick={() => startPayment(null)}
                >
                  {approving ? (
                    "Working out the cost…"
                  ) : (
                    <>
                      <CheckIcon aria-hidden="true" />
                      Approve &amp; pay all
                    </>
                  )}
                </Button>
              ) : null}
              {run.people > 0 ? (
                <Button
                  variant={canPay ? "outline" : "default"}
                  disabled={payment.busy || payments === null}
                  onClick={() => openForm({ kind: "one_off" })}
                >
                  <PlusIcon aria-hidden="true" />
                  Add a one-off payment
                </Button>
              ) : null}
            </SheetActions>
            {position}
            {passkey === "missing" ? (
              <ReadOnlyNote icon={KeyRoundIcon} wide>
                Paying needs your approval passkey.
              </ReadOnlyNote>
            ) : null}
          </>
        )
      }
    >
      {payment.result?.id === run.id ? (
        <PayrollResult run={payment.result} onDismiss={payment.dismissResult} />
      ) : null}
      {current.notice ? (
        <div role="status">
          <Callout tone="success">
            <p>{current.notice}</p>
          </Callout>
        </div>
      ) : null}
      {payment.error ? (
        <div role="alert">
          <Callout
            tone="error"
            action={<TreasuryOfferButton error={payment.failure} />}
          >
            <p>{payment.error}</p>
          </Callout>
        </div>
      ) : null}
      {isDraft && room.overCap ? (
        <div role="alert">
          <Callout tone="warn">
            <p className="tabular-nums">
              This run is KES {formatKes(room.cents)} over its cap, so it can’t
              be paid as it is. Lower someone’s pay or leave someone out.
            </p>
          </Callout>
        </div>
      ) : null}
      {isDraft && run.people === 0 ? (
        <Callout tone="neutral">
          <p>Nobody is paid in this run.</p>
        </Callout>
      ) : null}
      {isDraft ? <SheetNote>{DRAFT_TIMING}</SheetNote> : null}
      <DetailList>
        {progress ? <DetailItem label="Payments">{progress}</DetailItem> : null}
        <DetailItem label="People">
          {String(run.people)}
          {run.leftOut > 0 ? `, and ${String(run.leftOut)} left out` : ""}
        </DetailItem>
        <DetailItem
          label="Cap"
          sub={`Salaries of KES ${formatKes(run.salariesKes)} plus the company’s margin`}
        >
          <Money amount={run.capKes} currency="KES" />
        </DetailItem>
        {room.overCap ? null : (
          <DetailItem label="Room under the cap">
            <Money amount={room.cents} currency="KES" />
          </DetailItem>
        )}
        {run.approvedAt ? (
          <DetailItem label="Approved">
            {formatNairobiDateTime(run.approvedAt)}
          </DetailItem>
        ) : null}
        <DetailItem label="Overview heading">{OVERVIEW_HEADING}</DetailItem>
      </DetailList>
      <SectionLabel>Who’s paid</SectionLabel>
      {payments ? (
        <PayList
          run={run}
          payments={payments}
          canAct={canAct}
          passkey={passkey}
          payment={payment}
          onRetry={startPayment}
          onEdit={openForm}
        />
      ) : detail.isError ? (
        <Callout
          tone="error"
          action={
            <Button
              variant="outline"
              size="md"
              onClick={() => void detail.refetch()}
            >
              Try again
            </Button>
          }
        >
          <p>{describeApiError(detail.error)}</p>
        </Callout>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, at) => (
            <Skel key={at} width="100%" height={48} />
          ))}
        </div>
      )}
      {run.status === "paid" ? <SheetNote>{ZOHO_NOTE}</SheetNote> : null}
    </DetailSheet>
  );
}

function ReasonField({
  draft,
  onDraft,
  error,
  label = "Reason",
  placeholder,
}: {
  draft: ChangeDraft;
  onDraft: (draft: ChangeDraft) => void;
  error: string | undefined;
  label?: string;
  placeholder: string;
}): JSX.Element {
  return (
    <FormField id={FIELD_IDS.reason} label={label} error={error}>
      <Input
        id={FIELD_IDS.reason}
        maxLength={300}
        placeholder={placeholder}
        value={draft.reason}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onDraft({ ...draft, reason: event.target.value })}
      />
    </FormField>
  );
}

/** Who's paid: each person's amount and status, and what can change. */
function PayList({
  run,
  payments,
  canAct,
  passkey,
  payment,
  onRetry,
  onEdit,
}: {
  run: PayrollRun;
  payments: PayrollRunDetail["payments"];
  canAct: boolean;
  passkey: PasskeyState;
  payment: RunPayment;
  onRetry: (billId: string) => void;
  onEdit: (mode: RunMode) => void;
}): JSX.Element {
  if (payments.length === 0) {
    return (
      <Callout tone="neutral">
        <p>Nobody is in this run.</p>
      </Callout>
    );
  }
  const editable = canAct && run.status === "draft" && !payment.busy;
  return (
    <ul
      aria-label="Who’s paid"
      className="m-0 list-none rounded-lg border border-border p-0"
    >
      {sortPayments(payments).map((row) => {
        const leftOut = row.leftOut !== null;
        const badge = paymentStatusBadge(row.status, leftOut);
        const failed = row.status === "payout_failed" && !leftOut && canAct;
        const retrying =
          payment.preparing?.runId === run.id &&
          payment.preparing.retryBillId === row.billId;
        const receipts = receiptRows(row.paymentReceipts);
        return (
          <li
            key={row.billId}
            className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-t border-border p-3 first:border-t-0 max-[600px]:grid-cols-[32px_minmax(0,1fr)]"
          >
            <EntityMark name={row.payee.name} kind="person" />
            <div className="min-w-0">
              <p
                className={cn(
                  "font-(--w-name) [overflow-wrap:anywhere]",
                  leftOut && "text-muted-foreground",
                )}
              >
                {row.payee.name}
              </p>
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                {row.kind === "one_off"
                  ? `One-off: ${row.note ?? ""}`
                  : "Salary"}
              </p>
              {row.leftOut ? (
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                  Left out: {row.leftOut.reason}
                </p>
              ) : row.adjustmentReason ? (
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                  Changed for this run: {row.adjustmentReason}
                </p>
              ) : null}
              {row.payee.payoutPhoneConfirmed === false ? (
                <p className="mt-0.5 flex items-center gap-1 text-xs leading-4 text-warn-700">
                  <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
                  {UNCONFIRMED_NUMBER}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1.5 max-[600px]:col-start-2 max-[600px]:flex-row max-[600px]:items-center max-[600px]:justify-between">
              <Money
                amount={row.amountKes}
                currency="KES"
                className={cn(
                  "font-(--w-amount)",
                  leftOut && "text-muted-foreground line-through",
                )}
              />
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </div>
            {receipts.length > 0 ? (
              <div className="col-start-2 col-end-[-1] -mt-1 flex flex-col gap-2">
                {receipts.map((receipt) => (
                  <div key={receipt.kind}>
                    <p className="text-xs leading-4 text-muted-foreground">
                      {receipt.label}
                    </p>
                    <ReceiptCodes row={receipt} />
                  </div>
                ))}
              </div>
            ) : null}
            {failed || (editable && !leftOut) ? (
              <div className="col-start-2 col-end-[-1] -mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                {failed && passkey === "ready" ? (
                  <Button
                    variant="outline"
                    size="md"
                    disabled={payment.busy}
                    onClick={() => onRetry(row.billId)}
                  >
                    {retrying ? (
                      "Working out the cost…"
                    ) : (
                      <>
                        <RotateCcwIcon aria-hidden="true" />
                        Retry
                      </>
                    )}
                  </Button>
                ) : failed && passkey === "missing" ? (
                  <ReadOnlyNote icon={KeyRoundIcon}>
                    Retrying needs your approval passkey.
                  </ReadOnlyNote>
                ) : null}
                {editable ? (
                  <>
                    <TextLinkButton
                      onClick={() =>
                        onEdit({ kind: "adjust", billId: row.billId })
                      }
                    >
                      Change pay
                    </TextLinkButton>
                    <TextLinkButton
                      onClick={() =>
                        onEdit({ kind: "leave_out", billId: row.billId })
                      }
                    >
                      Leave out
                    </TextLinkButton>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
