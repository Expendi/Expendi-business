"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { BanIcon } from "lucide-react";
import { useId, useState } from "react";

import type { Invoice, MatchableDeposit } from "@expendi-business/shared";
import {
  invoiceMarkPaidSchema,
  invoiceVoidSchema,
} from "@expendi-business/shared";

import { Note } from "~/app/(company)/bills/_components/note";
import { SheetFooterPortal } from "~/app/(company)/bills/_components/sheet-footer";
import { Callout } from "~/components/data/detail-sheet";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { nairobiIsoDate } from "~/features/bills/bill-dates";
import { shortHash } from "~/features/invoices/invoice-status";
import {
  useDeleteInvoice,
  useMarkInvoicePaid,
  useMatchableDeposits,
  useMatchDeposit,
  useSendInvoice,
  useUndoInvoicePayment,
  useVoidInvoice,
} from "~/features/invoices/invoices-api";
import { describeApiError } from "~/lib/api";
import { formatNairobiDate } from "~/lib/dates";
import { formatUsdc } from "~/lib/money";

interface FormProps {
  organizationId: string;
  invoice: Invoice;
  footerSlot: HTMLElement | null;
  onDone: () => void;
}

/** A question with one consequence: the text, then a confirm and a way back. */
function ConfirmForm({
  label,
  footerSlot,
  children,
  confirmLabel,
  pendingLabel,
  backLabel = "Back",
  pending,
  error,
  danger = false,
  onConfirm,
  onBack,
}: {
  label: string;
  footerSlot: HTMLElement | null;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  backLabel?: string;
  pending: boolean;
  error: unknown;
  danger?: boolean;
  onConfirm: () => void;
  onBack: () => void;
}): JSX.Element {
  const uid = useId();
  return (
    <>
      <form
        id={`${uid}form`}
        aria-label={label}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
        className="flex flex-col gap-[18px]"
      >
        {children}
        {error ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button
          type="submit"
          form={`${uid}form`}
          variant={danger ? "destructive" : "default"}
          disabled={pending}
        >
          {pending ? pendingLabel : confirmLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={pending}
        >
          {backLabel}
        </Button>
      </SheetFooterPortal>
    </>
  );
}

export function SendInvoiceForm({
  organizationId,
  invoice,
  footerSlot,
  onDone,
}: FormProps): JSX.Element {
  const send = useSendInvoice(organizationId);
  return (
    <ConfirmForm
      label="Send invoice"
      footerSlot={footerSlot}
      confirmLabel="Send invoice"
      pendingLabel="Sending…"
      pending={send.isPending}
      error={send.error}
      onConfirm={() => send.mutate(invoice.id, { onSuccess: onDone })}
      onBack={onDone}
    >
      <Note>
        {invoice.customerName} gets an email at {invoice.billTo.email} with a
        link to pay. Sending locks the number and fixes the customer&apos;s
        details on the invoice; later changes to the customer apply to new
        invoices only.
      </Note>
    </ConfirmForm>
  );
}

export function DeleteDraftForm({
  organizationId,
  invoice,
  footerSlot,
  onDone,
  onDeleted,
}: FormProps & { onDeleted: () => void }): JSX.Element {
  const remove = useDeleteInvoice(organizationId, invoice.id);
  return (
    <ConfirmForm
      label="Delete draft"
      footerSlot={footerSlot}
      confirmLabel="Delete draft"
      pendingLabel="Deleting…"
      backLabel="Keep it"
      danger
      pending={remove.isPending}
      error={remove.error}
      onConfirm={() => remove.mutate(undefined, { onSuccess: onDeleted })}
      onBack={onDone}
    >
      <Callout tone="warn">
        <p>
          {invoice.number} is deleted for good, and its number can be used
          again.
        </p>
      </Callout>
    </ConfirmForm>
  );
}

export function UndoPaymentForm({
  organizationId,
  invoice,
  paymentId,
  footerSlot,
  onDone,
}: FormProps & { paymentId: string }): JSX.Element {
  const undo = useUndoInvoicePayment(organizationId, invoice.id);
  return (
    <ConfirmForm
      label="Undo payment"
      footerSlot={footerSlot}
      confirmLabel="Undo payment"
      pendingLabel="Undoing…"
      backLabel="Keep it"
      pending={undo.isPending}
      error={undo.error}
      onConfirm={() => undo.mutate(paymentId, { onSuccess: onDone })}
      onBack={onDone}
    >
      <Note>
        {invoice.number} goes back to open, and this payment is removed from it.
        A deposit that was matched stays in the wallet and can be matched again.
      </Note>
    </ConfirmForm>
  );
}

export function VoidInvoiceForm({
  organizationId,
  invoice,
  footerSlot,
  onDone,
}: FormProps): JSX.Element {
  const uid = useId();
  const voiding = useVoidInvoice(organizationId, invoice.id);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  function confirm() {
    const parsed = invoiceVoidSchema.safeParse({ reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? null);
      document.getElementById(`${uid}reason`)?.focus();
      return;
    }
    voiding.mutate(parsed.data, { onSuccess: onDone });
  }

  return (
    <ConfirmForm
      label="Void invoice"
      footerSlot={footerSlot}
      confirmLabel="Void invoice"
      pendingLabel="Voiding…"
      backLabel="Keep it"
      danger
      pending={voiding.isPending}
      error={voiding.error}
      onConfirm={confirm}
      onBack={onDone}
    >
      <Callout tone="warn" icon={BanIcon}>
        <p>
          Voiding can&apos;t be undone. The pay link will show that{" "}
          {invoice.number} was voided, and the number stays used.
        </p>
      </Callout>
      <Field>
        <FieldLabel htmlFor={`${uid}reason`}>
          Why are you voiding it?
        </FieldLabel>
        <Textarea
          id={`${uid}reason`}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
          maxLength={500}
          rows={3}
          disabled={voiding.isPending}
          aria-invalid={reasonError ? true : undefined}
        />
        {reasonError ? <FieldError>{reasonError}</FieldError> : null}
      </Field>
    </ConfirmForm>
  );
}

export function MarkPaidForm({
  organizationId,
  invoice,
  footerSlot,
  onDone,
}: FormProps): JSX.Element {
  const uid = useId();
  const mark = useMarkInvoicePaid(organizationId, invoice.id);
  const [today] = useState(() => nairobiIsoDate(new Date()));
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{
    paidOn?: string;
    reference?: string;
    note?: string;
  }>({});

  function confirm() {
    const parsed = invoiceMarkPaidSchema.safeParse({
      paidOn,
      ...(reference.trim() === "" ? {} : { reference }),
      ...(note.trim() === "" ? {} : { note }),
    });
    if (!parsed.success) {
      const found: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "paidOn" || key === "reference" || key === "note") {
          found[key] ??= issue.message;
        }
      }
      setErrors(found);
      return;
    }
    if (parsed.data.paidOn > today) {
      setErrors({ paidOn: "The date it was paid can't be in the future." });
      return;
    }
    mark.mutate(parsed.data, { onSuccess: onDone });
  }

  const disabled = mark.isPending;
  return (
    <ConfirmForm
      label="Mark paid"
      footerSlot={footerSlot}
      confirmLabel="Mark as paid"
      pendingLabel="Saving…"
      pending={mark.isPending}
      error={mark.error}
      onConfirm={confirm}
      onBack={onDone}
    >
      <Note>
        For a payment made outside Expendi, such as a bank transfer. The invoice
        is paid in full.
      </Note>
      <Field>
        <FieldLabel htmlFor={`${uid}paidOn`}>Date paid</FieldLabel>
        <Input
          id={`${uid}paidOn`}
          type="date"
          value={paidOn}
          max={today}
          onChange={(event) => {
            setPaidOn(event.target.value);
            setErrors((current) => ({ ...current, paidOn: undefined }));
          }}
          disabled={disabled}
          className="tabular-nums"
          aria-invalid={errors.paidOn ? true : undefined}
        />
        {errors.paidOn ? <FieldError>{errors.paidOn}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}reference`}>
          Reference (optional)
        </FieldLabel>
        <Input
          id={`${uid}reference`}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          maxLength={64}
          placeholder="Bank reference or cheque number"
          disabled={disabled}
          aria-invalid={errors.reference ? true : undefined}
        />
        {errors.reference ? <FieldError>{errors.reference}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}note`}>Note (optional)</FieldLabel>
        <Textarea
          id={`${uid}note`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={2}
          disabled={disabled}
          aria-invalid={errors.note ? true : undefined}
        />
        {errors.note ? <FieldError>{errors.note}</FieldError> : null}
      </Field>
    </ConfirmForm>
  );
}

export function MatchDepositForm({
  organizationId,
  invoice,
  footerSlot,
  onDone,
}: FormProps): JSX.Element {
  const uid = useId();
  const deposits = useMatchableDeposits(organizationId, invoice.id);
  const match = useMatchDeposit(organizationId, invoice.id);
  const [chosen, setChosen] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen) match.mutate(chosen, { onSuccess: onDone });
  }

  return (
    <>
      <form
        id={`${uid}form`}
        onSubmit={onSubmit}
        aria-label="Match a deposit"
        className="flex flex-col gap-[18px]"
      >
        <Note>
          Pick a deposit in the company wallet that no invoice uses yet, such as
          a short or late payment that arrived on its own.
        </Note>
        {deposits.isPending ? (
          <Skel width="100%" height={72} />
        ) : deposits.isError ? (
          <ErrorState
            title="Deposits didn't load"
            onRetry={() => void deposits.refetch()}
          />
        ) : deposits.data.length === 0 ? (
          <EmptyState title="No deposits to match">
            Deposits that arrive in the wallet and aren&apos;t on an invoice
            show up here.
          </EmptyState>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Deposits</legend>
            {deposits.data.map((deposit) => (
              <DepositChoice
                key={deposit.walletTransactionId}
                deposit={deposit}
                checked={chosen === deposit.walletTransactionId}
                disabled={match.isPending}
                onChoose={() => setChosen(deposit.walletTransactionId)}
              />
            ))}
          </fieldset>
        )}
        {match.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(match.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button
          type="submit"
          form={`${uid}form`}
          disabled={chosen === null || match.isPending}
        >
          {match.isPending ? "Matching…" : "Match deposit"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={match.isPending}
        >
          Back
        </Button>
      </SheetFooterPortal>
    </>
  );
}

function DepositChoice({
  deposit,
  checked,
  disabled,
  onChoose,
}: {
  deposit: MatchableDeposit;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-control border border-border p-3 has-checked:border-primary has-checked:bg-accent">
      <input
        type="radio"
        name="deposit"
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
        className="mt-1 accent-primary"
      />
      <span className="min-w-0">
        <span className="block font-(--w-amount) tabular-nums">
          {formatUsdc(deposit.amountUsdc)} USDC
        </span>
        <span className="block text-xs text-muted-foreground">
          {formatNairobiDate(deposit.receivedAt)}
          {deposit.from ? ` · from ${shortHash(deposit.from)}` : ""}
          {deposit.txHash ? ` · ${shortHash(deposit.txHash)}` : ""}
        </span>
      </span>
    </label>
  );
}
