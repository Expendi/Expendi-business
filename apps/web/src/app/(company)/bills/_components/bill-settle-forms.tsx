"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type { BillDetail } from "@expendi-business/shared";
import {
  BILL_NOTES_MAX_LENGTH,
  BILL_REASON_MAX_LENGTH,
  MAX_BILL_FILES_PER_REQUEST,
} from "@expendi-business/shared";

import type { UploadedBillFile } from "./bill-files-input";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { blankToNull } from "~/features/bills/bill-draft";
import { nairobiIsoDate } from "~/features/bills/bill-groups";
import {
  useAttachBillFiles,
  useCancelBill,
  useMarkBillPaidOutside,
  usePaidFromAccounts,
} from "~/features/bills/bills-api";
import { describeApiError } from "~/lib/api";
import { BillFilesInput } from "./bill-files-input";

/**
 * Paid outside Expendi (spec §6.20, §6.23): the date, an optional note and
 * proof, and the account it was paid from. It's also recorded as company
 * spending.
 */
export function MarkPaidOutsideForm({
  organizationId,
  bill,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  onDone: () => void;
}): JSX.Element {
  const mark = useMarkBillPaidOutside(organizationId, bill.id);
  const accounts = usePaidFromAccounts(organizationId);
  const [paidOn, setPaidOn] = useState(() => nairobiIsoDate(new Date()));
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState("");
  const [proof, setProof] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const busy = mark.isPending || uploading;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    <form
      onSubmit={onSubmit}
      aria-label="Mark paid outside Expendi"
      className="space-y-3 rounded-md border border-stone-200 p-3"
    >
      <h3 className="text-sm font-semibold">Mark paid outside Expendi</h3>
      <p className="text-xs text-stone-600">
        It&apos;s also recorded as company spending, under the account it was
        paid from.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          Date paid
          <input
            type="date"
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
            disabled={busy}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          Paid from
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={busy || accounts.isPending}
            className={inputClass}
          >
            <option value="">Not specified</option>
            {accounts.data
              ?.filter((account) => !account.archived)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        Note (optional)
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={BILL_NOTES_MAX_LENGTH}
          placeholder="Paid with the company card"
          disabled={busy}
          className={inputClass}
        />
      </label>
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
        <p className={alertClass} role="alert">
          {describeApiError(mark.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {mark.isPending ? "Saving…" : "Mark as paid"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={mark.isPending}
          className={secondaryButton}
        >
          Back
        </button>
      </div>
    </form>
  );
}

/** A bill that won't be paid, e.g. a cancelled subscription, with a reason. */
export function CancelBillForm({
  organizationId,
  bill,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  onDone: () => void;
}): JSX.Element {
  const cancel = useCancelBill(organizationId, bill.id);
  const [reason, setReason] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cancel.mutate({ reason }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Cancel this bill"
      className="space-y-3 rounded-md border border-stone-200 p-3"
    >
      <h3 className="text-sm font-semibold">Cancel this bill?</h3>
      <p className="text-xs text-stone-600">
        {bill.payee.name} won’t be paid for this bill. It stays in the history
        with your reason.
      </p>
      <label className="block text-sm">
        Why won’t it be paid?
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={BILL_REASON_MAX_LENGTH}
          placeholder="Subscription cancelled"
          disabled={cancel.isPending}
          className={inputClass}
        />
      </label>
      {cancel.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(cancel.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={cancel.isPending || reason.trim() === ""}
          className={primaryButton}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel bill"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={cancel.isPending}
          className={secondaryButton}
        >
          Keep it
        </button>
      </div>
    </form>
  );
}

/** Adds invoices to an existing bill: uploaded, then attached together. */
export function AddInvoicesForm({
  organizationId,
  bill,
  onDone,
}: {
  organizationId: string;
  bill: BillDetail;
  onDone: () => void;
}): JSX.Element {
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
    <form
      onSubmit={onSubmit}
      aria-label="Add an invoice"
      className="space-y-3 rounded-md border border-stone-200 p-3"
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
        <p className={alertClass} role="alert">
          {describeApiError(attach.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={attach.isPending || uploading || invoices.length === 0}
          className={primaryButton}
        >
          {attach.isPending ? "Attaching…" : "Attach"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={attach.isPending}
          className={secondaryButton}
        >
          Back
        </button>
      </div>
    </form>
  );
}
