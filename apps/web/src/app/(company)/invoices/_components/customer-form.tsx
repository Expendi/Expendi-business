"use client";

import type { FormEvent, JSX } from "react";
import { useId, useState } from "react";

import type { Customer } from "@expendi-business/shared";

import type {
  CustomerDraft,
  CustomerField,
} from "~/features/invoices/customer-draft";
import { SheetFooterPortal } from "~/app/(company)/bills/_components/sheet-footer";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  BLANK_CUSTOMER,
  customerDraftOf,
  toCustomerInput,
  toCustomerUpdate,
} from "~/features/invoices/customer-draft";
import {
  useCreateCustomer,
  useUpdateCustomer,
} from "~/features/invoices/invoices-api";
import { describeApiError } from "~/lib/api";

export type CustomerErrors = Partial<Record<CustomerField, string>>;

const FIELD_ORDER: readonly CustomerField[] = [
  "name",
  "email",
  "address",
  "taxId",
];

/** A customer's four fields, controlled; the invoice form and the customer sheet share them. */
export function CustomerFields({
  idPrefix,
  draft,
  errors,
  disabled,
  onChange,
}: {
  idPrefix: string;
  draft: CustomerDraft;
  errors: CustomerErrors;
  disabled: boolean;
  onChange: (changes: Partial<CustomerDraft>, field: CustomerField) => void;
}): JSX.Element {
  const id = (field: CustomerField) => `${idPrefix}${field}`;
  const invalid = (field: CustomerField) =>
    errors[field] ? { "aria-invalid": true } : {};
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id("name")}>Name</FieldLabel>
        <Input
          id={id("name")}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value }, "name")}
          autoComplete="off"
          placeholder="Acme Logistics Ltd"
          disabled={disabled}
          {...invalid("name")}
        />
        {errors.name ? <FieldError>{errors.name}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={id("email")}>Billing email</FieldLabel>
        <Input
          id={id("email")}
          type="email"
          value={draft.email}
          onChange={(event) => onChange({ email: event.target.value }, "email")}
          autoComplete="off"
          placeholder="accounts@acme.co.ke"
          disabled={disabled}
          {...invalid("email")}
        />
        {errors.email ? <FieldError>{errors.email}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={id("address")}>Address (optional)</FieldLabel>
        <Textarea
          id={id("address")}
          value={draft.address}
          onChange={(event) =>
            onChange({ address: event.target.value }, "address")
          }
          rows={2}
          disabled={disabled}
          {...invalid("address")}
        />
        {errors.address ? <FieldError>{errors.address}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={id("taxId")}>
          Tax ID or KRA PIN (optional)
        </FieldLabel>
        <Input
          id={id("taxId")}
          value={draft.taxId}
          onChange={(event) => onChange({ taxId: event.target.value }, "taxId")}
          autoComplete="off"
          disabled={disabled}
          {...invalid("taxId")}
        />
        {errors.taxId ? <FieldError>{errors.taxId}</FieldError> : null}
      </Field>
    </>
  );
}

function useCustomerDraft(initial: CustomerDraft) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<CustomerErrors>({});
  function change(changes: Partial<CustomerDraft>, field: CustomerField) {
    setDraft((current) => ({ ...current, ...changes }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }
  function fail(found: CustomerErrors, idPrefix: string) {
    setErrors(found);
    const first = FIELD_ORDER.find((field) => found[field] !== undefined);
    if (first) document.getElementById(`${idPrefix}${first}`)?.focus();
  }
  return { draft, errors, change, fail, clear: () => setErrors({}) };
}

/**
 * A customer, new or edited, in the side sheet. An existing customer can be
 * archived and brought back; a customer an invoice names is never deleted.
 */
export function CustomerForm({
  organizationId,
  customer,
  footerSlot,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  customer: Customer | null;
  footerSlot: HTMLElement | null;
  onSaved: (customer: Customer) => void;
  onCancel: () => void;
}): JSX.Element {
  const uid = useId();
  const formId = `${uid}form`;
  const create = useCreateCustomer(organizationId);
  const update = useUpdateCustomer(organizationId, customer?.id ?? "");
  const form = useCustomerDraft(
    customer ? customerDraftOf(customer) : BLANK_CUSTOMER,
  );
  const save = customer ? update : create;
  const busy = save.isPending;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.reset();
    if (customer) {
      const result = toCustomerUpdate(form.draft);
      if (!result.ok) return form.fail(result.errors, uid);
      form.clear();
      update.mutate(result.input, { onSuccess: onSaved });
      return;
    }
    const result = toCustomerInput(form.draft);
    if (!result.ok) return form.fail(result.errors, uid);
    form.clear();
    create.mutate(result.input, { onSuccess: onSaved });
  }

  return (
    <>
      <form
        id={formId}
        onSubmit={onSubmit}
        noValidate
        aria-label={customer ? "Edit customer" : "New customer"}
        className="flex flex-col gap-[18px]"
      >
        <CustomerFields
          idPrefix={uid}
          draft={form.draft}
          errors={form.errors}
          disabled={busy}
          onChange={(changes, field) => {
            save.reset();
            form.change(changes, field);
          }}
        />
        {save.isError ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(save.error)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button type="submit" form={formId} disabled={busy}>
          {busy ? "Saving…" : customer ? "Save changes" : "Add customer"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        {customer ? (
          <ArchiveButton
            organizationId={organizationId}
            customer={customer}
            disabled={busy}
            onDone={onSaved}
          />
        ) : null}
      </SheetFooterPortal>
    </>
  );
}

function ArchiveButton({
  organizationId,
  customer,
  disabled,
  onDone,
}: {
  organizationId: string;
  customer: Customer;
  disabled: boolean;
  onDone: (customer: Customer) => void;
}): JSX.Element {
  const update = useUpdateCustomer(organizationId, customer.id);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="ml-auto"
        disabled={disabled || update.isPending}
        onClick={() =>
          update.mutate({ archived: !customer.archived }, { onSuccess: onDone })
        }
      >
        {update.isPending
          ? "Saving…"
          : customer.archived
            ? "Unarchive"
            : "Archive"}
      </Button>
      {update.isError ? (
        <p role="alert" className="basis-full text-error-700">
          {describeApiError(update.error)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Adds a customer from inside the invoice form, then hands it back to be
 * chosen. It sits beside the invoice form, not in it: forms can't nest.
 */
export function InlineCustomer({
  organizationId,
  onCreated,
  onCancel,
}: {
  organizationId: string;
  onCreated: (customer: Customer) => void;
  onCancel: () => void;
}): JSX.Element {
  const uid = useId();
  const create = useCreateCustomer(organizationId);
  const form = useCustomerDraft(BLANK_CUSTOMER);

  function add() {
    create.reset();
    const result = toCustomerInput(form.draft);
    if (!result.ok) return form.fail(result.errors, uid);
    form.clear();
    create.mutate(result.input, { onSuccess: onCreated });
  }

  return (
    <fieldset className="flex flex-col gap-4 rounded-control border border-border bg-muted/40 p-4">
      <legend className="px-1 text-sm font-(--w-ui)">New customer</legend>
      <CustomerFields
        idPrefix={uid}
        draft={form.draft}
        errors={form.errors}
        disabled={create.isPending}
        onChange={(changes, field) => {
          create.reset();
          form.change(changes, field);
        }}
      />
      {create.isError ? (
        <Callout tone="error">
          <p role="alert">{describeApiError(create.error)}</p>
        </Callout>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" onClick={add} disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add customer"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={create.isPending}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
