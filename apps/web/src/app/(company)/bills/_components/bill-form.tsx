"use client";

import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type {
  Bill,
  BillDetail,
  BillHeading,
  Payee,
} from "@expendi-business/shared";
import {
  BILL_HEADINGS,
  BILL_NOTES_MAX_LENGTH,
  BILL_REASON_MAX_LENGTH,
  BILL_REFERENCE_MAX_LENGTH,
  MAX_BILL_FILES_PER_REQUEST,
} from "@expendi-business/shared";

import type { UploadedBillFile } from "./bill-files-input";
import type { BillDraft } from "~/features/bills/bill-draft";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { CURRENCY_LABELS, currencyOfPayee } from "~/features/bills/bill-amount";
import {
  amountChanged,
  draftFromBill,
  toCreateRequest,
  toUpdateRequest,
} from "~/features/bills/bill-draft";
import { HEADING_LABELS } from "~/features/bills/bill-status";
import { useCreateBill, useUpdateBill } from "~/features/bills/bills-api";
import { KIND_LABELS, METHOD_LABELS } from "~/features/payees/payee-display";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { BillFilesInput } from "./bill-files-input";

const BLANK_DRAFT: BillDraft = {
  payeeId: null,
  variable: false,
  currency: "kes",
  amount: "",
  dueOn: "",
  heading: null,
  categoryId: null,
  reference: "",
  notes: "",
  adjustmentReason: "",
};

function payeeOption(payee: Payee): string {
  const method = payee.details
    ? METHOD_LABELS[payee.details.method]
    : "No payment details yet";
  return `${payee.name} · ${KIND_LABELS[payee.kind]} · ${method}`;
}

/**
 * A bill's form (spec §6.20), new or edited, as the app has it
 * (`apps/mobile/src/features/bills/bill-form.tsx`). A variable bill can be
 * saved without its amount, which is entered here before it's paid. The
 * amount is in USD for a payee paid in USDC.
 */
export function BillForm({
  organizationId,
  bill,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  /** The bill being edited; null for a new one. */
  bill: Bill | null;
  onSaved: (bill: BillDetail) => void;
  onCancel: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const payees = usePayees(organizationId, ACTIVE_PAYEES);
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });
  const create = useCreateBill(organizationId);
  const update = useUpdateBill(organizationId, bill?.id ?? "");
  const [draft, setDraft] = useState<BillDraft>(() =>
    bill ? draftFromBill(bill) : BLANK_DRAFT,
  );
  const [invoices, setInvoices] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const save = bill ? update : create;
  const busy = save.isPending || uploading;

  const change = (fields: Partial<BillDraft>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...fields }));
  };

  function choosePayee(payeeId: string) {
    const payee = payees.data?.find((candidate) => candidate.id === payeeId);
    const currency = currencyOfPayee(payee?.details?.method, "kes");
    change({
      payeeId: payeeId === "" ? null : payeeId,
      currency,
      amount: currency === draft.currency ? draft.amount : "",
    });
  }

  const askReason =
    bill !== null && !bill.variable && amountChanged(bill, draft);
  const updateRequest = bill ? toUpdateRequest(bill, draft) : null;
  const unchanged =
    updateRequest !== null && Object.keys(updateRequest).length === 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bill && updateRequest) {
      update.mutate(updateRequest, { onSuccess: onSaved });
      return;
    }
    create.mutate(
      toCreateRequest(
        draft,
        invoices.map((file) => file.id),
      ),
      { onSuccess: onSaved },
    );
  }

  const payeeChoices = (payees.data ?? []).filter(
    (payee) => payee.id === draft.payeeId || !payee.archived,
  );
  const currency = CURRENCY_LABELS[draft.currency];

  return (
    <form
      onSubmit={onSubmit}
      aria-label={bill ? "Edit bill" : "New bill"}
      className="space-y-4"
    >
      <h2 className="text-lg font-semibold">
        {bill ? "Edit bill" : "New bill"}
      </h2>
      <label className="block text-sm">
        Pay to
        <select
          value={draft.payeeId ?? ""}
          onChange={(event) => choosePayee(event.target.value)}
          disabled={busy || payees.isPending}
          className={inputClass}
        >
          <option value="">
            {payees.isPending ? "Loading payees…" : "Choose a payee"}
          </option>
          {payeeChoices.map((payee) => (
            <option key={payee.id} value={payee.id}>
              {payeeOption(payee)}
            </option>
          ))}
        </select>
      </label>
      {payees.isSuccess && payeeChoices.length === 0 ? (
        <p className="text-sm text-stone-600">
          Add the payee under Payees first.
        </p>
      ) : null}

      {bill === null ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.variable}
            onChange={(event) => change({ variable: event.target.checked })}
            disabled={busy}
            className="mt-0.5"
          />
          <span>
            Variable amount
            <span className="block text-xs text-stone-500">
              e.g. PAYE or electricity: save it now and enter the amount before
              it&apos;s paid.
            </span>
          </span>
        </label>
      ) : null}

      <label className="block text-sm">
        Amount ({currency}){draft.variable ? ", optional for now" : ""}
        <input
          value={draft.amount}
          onChange={(event) => change({ amount: event.target.value })}
          inputMode="decimal"
          placeholder={draft.currency === "usd" ? "120.00" : "15,000.00"}
          disabled={busy}
          className={inputClass}
        />
      </label>
      {draft.currency === "usd" ? (
        <p className="text-xs text-stone-500">
          This payee is paid in USDC: the bill pays exactly this many USDC.
        </p>
      ) : null}
      {askReason ? (
        <label className="block text-sm">
          Why did the amount change?
          <input
            value={draft.adjustmentReason}
            onChange={(event) =>
              change({ adjustmentReason: event.target.value })
            }
            maxLength={BILL_REASON_MAX_LENGTH}
            placeholder="Late fee added"
            disabled={busy}
            className={inputClass}
          />
        </label>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          Due date
          <input
            type="date"
            value={draft.dueOn}
            onChange={(event) => change({ dueOn: event.target.value })}
            disabled={busy}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          Overview heading
          <select
            value={draft.heading ?? ""}
            onChange={(event) =>
              change({
                heading:
                  BILL_HEADINGS.find(
                    (heading): heading is BillHeading =>
                      heading === event.target.value,
                  ) ?? null,
              })
            }
            disabled={busy}
            className={inputClass}
          >
            {bill === null ? <option value="">Follows the payee</option> : null}
            {BILL_HEADINGS.map((heading) => (
              <option key={heading} value={heading}>
                {HEADING_LABELS[heading]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        Category
        <select
          value={draft.categoryId ?? ""}
          onChange={(event) =>
            change({
              categoryId: event.target.value === "" ? null : event.target.value,
            })
          }
          disabled={busy || categories.isPending}
          className={inputClass}
        >
          <option value="">
            {categories.isPending ? "Loading categories…" : "Choose a category"}
          </option>
          {bill && !categories.data?.some((c) => c.id === bill.category.id) ? (
            <option value={bill.category.id}>{bill.category.name}</option>
          ) : null}
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        Reference (optional)
        <input
          value={draft.reference}
          onChange={(event) => change({ reference: event.target.value })}
          maxLength={BILL_REFERENCE_MAX_LENGTH}
          placeholder="Invoice or KRA payment number"
          disabled={busy}
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        Notes (optional)
        <textarea
          value={draft.notes}
          onChange={(event) => change({ notes: event.target.value })}
          maxLength={BILL_NOTES_MAX_LENGTH}
          rows={2}
          disabled={busy}
          className={inputClass}
        />
      </label>

      {bill === null ? (
        <BillFilesInput
          organizationId={organizationId}
          label="Invoice (optional)"
          files={invoices}
          onChange={setInvoices}
          onUploadingChange={setUploading}
          max={MAX_BILL_FILES_PER_REQUEST}
          disabled={save.isPending}
        />
      ) : null}

      {payees.isError || categories.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(payees.error ?? categories.error)}
        </p>
      ) : null}
      {save.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(save.error)}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy || unchanged}
          className={primaryButton}
        >
          {uploading
            ? "Uploading…"
            : save.isPending
              ? "Saving…"
              : bill
                ? "Save changes"
                : "Add bill"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={save.isPending}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
