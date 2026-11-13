"use client";

import type { FormEvent, JSX } from "react";
import { BanIcon } from "lucide-react";
import { useId, useState } from "react";

import type { BillDetail } from "@expendi-business/shared";
import {
  BILL_NOTES_MAX_LENGTH,
  BILL_REASON_MAX_LENGTH,
  MAX_BILL_FILES_PER_REQUEST,
} from "@expendi-business/shared";

import type { UploadedBillFile } from "./bill-files-input";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import { nairobiIsoDate } from "~/features/bills/bill-dates";
import { blankToNull } from "~/features/bills/bill-draft";
import {
  useAttachBillFiles,
  useCancelBill,
  useMarkBillPaidOutside,
  usePaidFromAccounts,
} from "~/features/bills/bills-api";
import { describeApiError } from "~/lib/api";
import { BillFilesInput } from "./bill-files-input";
import { Note } from "./note";
import { SheetFooterPortal } from "./sheet-footer";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why the date paid can't be saved, or null. */
export function paidOnError(paidOn: string, today: string): string | null {
  if (!ISO_DATE.test(paidOn)) {
    return "Enter the date it was paid as YYYY-MM-DD.";
  }
  if (paidOn > today) return "The date it was paid can't be in the future.";
  return null;
}

/**
 * Paid outside Expendi (spec §6.20, §6.23): the date, an optional note and
 * proof, and the account it was paid from. It's also recorded as company
 * spending.
 */
export function MarkPaidOutsideForm({
  organizationId,
  bill,
  footerSlot,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  footerSlot: HTMLElement | null;
  onDone: () => void;
}): JSX.Element {
  const uid = useId();
  const mark = useMarkBillPaidOutside(organizationId, bill.id);
  const accounts = usePaidFromAccounts(organizationId);
  const [today] = useState(() => nairobiIsoDate(new Date()));
  const [paidOn, setPaidOn] = useState(today);
  const [dateError, setDateError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState("");
  const [proof, setProof] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const busy = mark.isPending || uploading;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = paidOnError(paidOn, today);
    setDateError(invalid);
    if (invalid) {
      document.getElementById(`${uid}date`)?.focus();
      return;
    }
    mark.mutate(
      {
        paidOn,
        note: blankToNull(note),
        receiptFileIds: proof.map((file) => file.id),
        paidFromAccountId: accountId === "" ? null : accountId,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <>
      <form
        id={`${uid}form`}
        onSubmit={onSubmit}
        noValidate
        aria-label="Mark paid outside Expendi"
        className="flex flex-col gap-[18px]"
      >
        <Note>
          It&apos;s also recorded as company spending, under the account it was
          paid from.
        </Note>
        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={`${uid}date`}>Date paid</FieldLabel>
            <Input
              id={`${uid}date`}
              type="date"
              value={paidOn}
              max={today}
              onChange={(event) => {
                setPaidOn(event.target.value);
                setDateError(null);
              }}
              disabled={busy}
              className="tabular-nums"
              aria-invalid={dateError ? true : undefined}
            />
            {dateError ? <FieldError>{dateError}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}from`}>Paid from</FieldLabel>
            <NativeSelect
              id={`${uid}from`}
              className="w-full"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={busy || accounts.isPending}
            >
              <NativeSelectOption value="">Not specified</NativeSelectOption>
              {accounts.data
                ?.filter((account) => !account.archived)
                .map((account) => (
                  <NativeSelectOption key={account.id} value={account.id}>
                    {account.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${uid}note`}>Note (optional)</FieldLabel>
          <Input
            id={`${uid}note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={BILL_NOTES_MAX_LENGTH}
            placeholder="Paid with a bank card"
            disabled={busy}
          />
        </Field>
        <BillFilesInput
          organizationId={organizationId}
          label="Proof of payment (optional)"
          files={proof}
          onChange={setProof}
          onUploadingChange={setUploading}
          max={MAX_BILL_FILES_PER_REQUEST}
          disabled={mark.isPending}
        />
        {mark.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(mark.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button type="submit" form={`${uid}form`} disabled={busy}>
          {mark.isPending ? "Saving…" : "Mark as paid"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={mark.isPending}
        >
          Back
        </Button>
      </SheetFooterPortal>
    </>
  );
}

/** A bill that won't be paid, e.g. a cancelled subscription, with a reason. */
export function CancelBillForm({
  organizationId,
  bill,
  footerSlot,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  footerSlot: HTMLElement | null;
  onDone: () => void;
}): JSX.Element {
  const uid = useId();
  const cancel = useCancelBill(organizationId, bill.id);
  const [reason, setReason] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cancel.mutate({ reason }, { onSuccess: onDone });
  }

  return (
    <>
      <form
        id={`${uid}form`}
        onSubmit={onSubmit}
        aria-label="Cancel this bill"
        className="flex flex-col gap-[18px]"
      >
        <Callout tone="warn" icon={BanIcon}>
          <p>
            {bill.payee.name} won’t be paid for this bill. It stays in the
            history with your reason.
          </p>
        </Callout>
        <Field>
          <FieldLabel htmlFor={`${uid}reason`}>
            Why won’t it be paid?
          </FieldLabel>
          <Textarea
            id={`${uid}reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={BILL_REASON_MAX_LENGTH}
            rows={3}
            placeholder="Subscription cancelled"
            disabled={cancel.isPending}
          />
        </Field>
        {cancel.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(cancel.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button
          type="submit"
          form={`${uid}form`}
          disabled={cancel.isPending || reason.trim() === ""}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel bill"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={cancel.isPending}
        >
          Keep it
        </Button>
      </SheetFooterPortal>
    </>
  );
}

/** Adds invoices to an existing bill: uploaded, then attached together. */
export function AddInvoicesForm({
  organizationId,
  bill,
  footerSlot,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  footerSlot: HTMLElement | null;
  onDone: () => void;
}): JSX.Element {
  const uid = useId();
  const attach = useAttachBillFiles(organizationId, bill.id);
  const [invoices, setInvoices] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    attach.mutate(
      invoices.map((file) => file.id),
      { onSuccess: onDone },
    );
  }

  return (
    <>
      <form
        id={`${uid}form`}
        onSubmit={onSubmit}
        aria-label="Add an invoice"
        className="flex flex-col gap-[18px]"
      >
        <BillFilesInput
          organizationId={organizationId}
          label="Invoice"
          files={invoices}
          onChange={setInvoices}
          onUploadingChange={setUploading}
          max={MAX_BILL_FILES_PER_REQUEST}
          disabled={attach.isPending}
        />
        {attach.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(attach.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button
          type="submit"
          form={`${uid}form`}
          disabled={attach.isPending || uploading || invoices.length === 0}
        >
          {attach.isPending ? "Attaching…" : "Attach"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={attach.isPending}
        >
          Back
        </Button>
      </SheetFooterPortal>
    </>
  );
}
