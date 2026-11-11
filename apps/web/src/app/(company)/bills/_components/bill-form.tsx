"use client";

import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

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
  createBillRequestSchema,
  MAX_BILL_FILES_PER_REQUEST,
  updateBillRequestSchema,
} from "@expendi-business/shared";

import type { UploadedBillFile } from "./bill-files-input";
import type { BillDraft } from "~/features/bills/bill-draft";
import { RowCheckbox } from "~/components/data/cells";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
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
import { fieldErrorsOf, focusFirstError } from "./form-errors";
import { SheetFooterPortal } from "./sheet-footer";

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

type BillField =
  | "payee"
  | "amount"
  | "reason"
  | "dueOn"
  | "heading"
  | "category"
  | "reference"
  | "notes";

const REQUEST_FIELDS: Readonly<Record<string, BillField>> = {
  payeeId: "payee",
  amountKes: "amount",
  amountUsd: "amount",
  adjustmentReason: "reason",
  dueOn: "dueOn",
  overviewHeading: "heading",
  categoryId: "category",
  reference: "reference",
  notes: "notes",
};

const FIELD_ORDER: readonly BillField[] = [
  "payee",
  "amount",
  "dueOn",
  "reason",
  "heading",
  "category",
  "reference",
  "notes",
];

type Issues = readonly { path: readonly PropertyKey[]; message: string }[];

function payeeOption(payee: Payee): string {
  const method = payee.details
    ? METHOD_LABELS[payee.details.method]
    : "No payment details yet";
  return `${payee.name} (${KIND_LABELS[payee.kind]}, ${method})`;
}

/**
 * A bill's form (spec §6.20), new or edited, as the app has it
 * (`apps/mobile/src/features/bills/bill-form.tsx`). A variable bill can be
 * saved without its amount, which is entered here before it's paid. The
 * amount is in USD for a payee paid in USDC. Its buttons sit in the side
 * sheet's footer (`footerSlot`).
 */
export function BillForm({
  organizationId,
  bill,
  footerSlot,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  /** The bill being edited; null for a new one. */
  bill: Bill | null;
  footerSlot: HTMLElement | null;
  onSaved: (bill: BillDetail) => void;
  onCancel: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const uid = useId();
  const formId = `${uid}form`;
  const idOf = (field: BillField) => `${uid}${field}`;
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
  const [errors, setErrors] = useState<
    Partial<Record<BillField | "form", string>>
  >({});
  const [invoices, setInvoices] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const save = bill ? update : create;
  const busy = save.isPending || uploading;

  function change(fields: Partial<BillDraft>, field: BillField) {
    save.reset();
    setDraft((current) => ({ ...current, ...fields }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function choosePayee(payeeId: string) {
    const payee = payees.data?.find((candidate) => candidate.id === payeeId);
    const currency = currencyOfPayee(payee?.details?.method, "kes");
    change(
      {
        payeeId: payeeId === "" ? null : payeeId,
        currency,
        amount: currency === draft.currency ? draft.amount : "",
      },
      "payee",
    );
  }

  const askReason =
    bill !== null && !bill.variable && amountChanged(bill, draft);
  const updateRequest = bill ? toUpdateRequest(bill, draft) : null;
  const unchanged =
    updateRequest !== null && Object.keys(updateRequest).length === 0;

  function invalid(issues: Issues) {
    const found = fieldErrorsOf(issues, REQUEST_FIELDS);
    setErrors(found);
    focusFirstError(
      FIELD_ORDER.map((field) => ({ field, id: idOf(field) })),
      found,
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bill && updateRequest) {
      const parsed = updateBillRequestSchema.safeParse(updateRequest);
      if (!parsed.success) {
        invalid(parsed.error.issues);
        return;
      }
      setErrors({});
      update.mutate(updateRequest, { onSuccess: onSaved });
      return;
    }
    const request = toCreateRequest(
      draft,
      invoices.map((file) => file.id),
    );
    const parsed = createBillRequestSchema.safeParse(request);
    if (!parsed.success) {
      invalid(parsed.error.issues);
      return;
    }
    setErrors({});
    create.mutate(request, { onSuccess: onSaved });
  }

  const payeeChoices = (payees.data ?? []).filter(
    (payee) =>
      payee.id === draft.payeeId ||
      (!payee.archived && payee.kind !== "employee"),
  );
  const currency = CURRENCY_LABELS[draft.currency];
  const loadError = payees.error ?? categories.error;
  const invalidProps = (field: BillField) =>
    errors[field] ? { "aria-invalid": true } : {};

  return (
    <>
      <form
        id={formId}
        onSubmit={onSubmit}
        noValidate
        aria-label={bill ? "Edit bill" : "New bill"}
        className="flex flex-col gap-[18px]"
      >
        <Field>
          <FieldLabel htmlFor={idOf("payee")}>Pay to</FieldLabel>
          <NativeSelect
            id={idOf("payee")}
            className="w-full"
            value={draft.payeeId ?? ""}
            onChange={(event) => choosePayee(event.target.value)}
            disabled={busy || payees.isPending}
            {...invalidProps("payee")}
          >
            <NativeSelectOption value="">
              {payees.isPending ? "Loading payees…" : "Choose a payee"}
            </NativeSelectOption>
            {payeeChoices.map((payee) => (
              <NativeSelectOption key={payee.id} value={payee.id}>
                {payeeOption(payee)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {errors.payee ? <FieldError>{errors.payee}</FieldError> : null}
          {payees.isSuccess && payeeChoices.length === 0 ? (
            <FieldDescription>
              Add the payee under Payees first.
            </FieldDescription>
          ) : null}
        </Field>

        {bill === null ? (
          <label className="flex cursor-pointer items-start gap-2.5">
            <RowCheckbox
              className="mt-px"
              checked={draft.variable}
              onChange={(event) =>
                change({ variable: event.target.checked }, "amount")
              }
              disabled={busy}
            />
            <span>
              <span className="block text-sm font-(--w-ui) text-foreground">
                Variable amount
              </span>
              <span className="block text-xs leading-4 text-muted-foreground">
                e.g. PAYE or electricity: save it now and enter the amount
                before it&apos;s paid.
              </span>
            </span>
          </label>
        ) : null}

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={idOf("amount")}>
              Amount ({currency})
              {bill === null && draft.variable ? ", optional for now" : ""}
            </FieldLabel>
            <Input
              id={idOf("amount")}
              value={draft.amount}
              onChange={(event) =>
                change({ amount: event.target.value }, "amount")
              }
              inputMode="decimal"
              autoComplete="off"
              placeholder={draft.currency === "usd" ? "120.00" : "15,000.00"}
              disabled={busy}
              className="tabular-nums"
              {...invalidProps("amount")}
            />
            {draft.currency === "usd" ? (
              <FieldDescription>
                This payee is paid in USDC: the bill pays exactly this many
                USDC.
              </FieldDescription>
            ) : null}
            {errors.amount ? <FieldError>{errors.amount}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={idOf("dueOn")}>Due date</FieldLabel>
            <Input
              id={idOf("dueOn")}
              type="date"
              value={draft.dueOn}
              onChange={(event) =>
                change({ dueOn: event.target.value }, "dueOn")
              }
              disabled={busy}
              className="tabular-nums"
              {...invalidProps("dueOn")}
            />
            {errors.dueOn ? <FieldError>{errors.dueOn}</FieldError> : null}
          </Field>
        </div>

        {askReason ? (
          <Field>
            <FieldLabel htmlFor={idOf("reason")}>
              Why did the amount change?
            </FieldLabel>
            <Input
              id={idOf("reason")}
              value={draft.adjustmentReason}
              onChange={(event) =>
                change({ adjustmentReason: event.target.value }, "reason")
              }
              maxLength={BILL_REASON_MAX_LENGTH}
              placeholder="Late fee added"
              disabled={busy}
              {...invalidProps("reason")}
            />
            {errors.reason ? <FieldError>{errors.reason}</FieldError> : null}
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={idOf("heading")}>Overview heading</FieldLabel>
            <NativeSelect
              id={idOf("heading")}
              className="w-full"
              value={draft.heading ?? ""}
              onChange={(event) =>
                change(
                  {
                    heading:
                      BILL_HEADINGS.find(
                        (heading): heading is BillHeading =>
                          heading === event.target.value,
                      ) ?? null,
                  },
                  "heading",
                )
              }
              disabled={busy}
            >
              {bill === null ? (
                <NativeSelectOption value="">
                  Follows the payee
                </NativeSelectOption>
              ) : null}
              {BILL_HEADINGS.map((heading) => (
                <NativeSelectOption key={heading} value={heading}>
                  {HEADING_LABELS[heading]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={idOf("category")}>Category</FieldLabel>
            <NativeSelect
              id={idOf("category")}
              className="w-full"
              value={draft.categoryId ?? ""}
              onChange={(event) =>
                change(
                  {
                    categoryId:
                      event.target.value === "" ? null : event.target.value,
                  },
                  "category",
                )
              }
              disabled={busy || categories.isPending}
              {...invalidProps("category")}
            >
              <NativeSelectOption value="">
                {categories.isPending
                  ? "Loading categories…"
                  : "Choose a category"}
              </NativeSelectOption>
              {bill &&
              !categories.data?.some((c) => c.id === bill.category.id) ? (
                <NativeSelectOption value={bill.category.id}>
                  {bill.category.name}
                </NativeSelectOption>
              ) : null}
              {categories.data?.map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>
                  {category.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {errors.category ? (
              <FieldError>{errors.category}</FieldError>
            ) : null}
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={idOf("reference")}>
            Reference (optional)
          </FieldLabel>
          <Input
            id={idOf("reference")}
            value={draft.reference}
            onChange={(event) =>
              change({ reference: event.target.value }, "reference")
            }
            maxLength={BILL_REFERENCE_MAX_LENGTH}
            placeholder="Invoice or KRA payment number"
            disabled={busy}
            {...invalidProps("reference")}
          />
          {errors.reference ? (
            <FieldError>{errors.reference}</FieldError>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={idOf("notes")}>Notes (optional)</FieldLabel>
          <Textarea
            id={idOf("notes")}
            value={draft.notes}
            onChange={(event) => change({ notes: event.target.value }, "notes")}
            maxLength={BILL_NOTES_MAX_LENGTH}
            rows={2}
            disabled={busy}
            {...invalidProps("notes")}
          />
          {errors.notes ? <FieldError>{errors.notes}</FieldError> : null}
        </Field>

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

        {loadError ? (
          <Callout tone="error">
            <p>{describeApiError(loadError)}</p>
          </Callout>
        ) : null}
        {errors.form ? (
          <Callout tone="error">
            <p>{errors.form}</p>
          </Callout>
        ) : null}
        {save.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(save.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button type="submit" form={formId} disabled={busy || unchanged}>
          {uploading
            ? "Uploading…"
            : save.isPending
              ? "Saving…"
              : bill
                ? "Save changes"
                : "Add bill"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={save.isPending}
        >
          Cancel
        </Button>
      </SheetFooterPortal>
    </>
  );
}
