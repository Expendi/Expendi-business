"use client";

import type { FormEvent, JSX } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import type { Customer, Invoice } from "@expendi-business/shared";
import { INVOICE_TERMS, MAX_INVOICE_LINES } from "@expendi-business/shared";

import type {
  DraftErrors,
  InvoiceDraft,
} from "~/features/invoices/invoice-draft";
import { SheetFooterPortal } from "~/app/(company)/bills/_components/sheet-footer";
import { IconButton, TextLinkButton } from "~/components/data/actions";
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
import { nairobiIsoDate } from "~/features/bills/bill-dates";
import {
  blankDraft,
  blankLine,
  draftFromInvoice,
  dueDateOf,
  toDraftRequest,
} from "~/features/invoices/invoice-draft";
import {
  bpsToPercent,
  computeTotals,
  dollarsToCents,
  percentToBps,
} from "~/features/invoices/invoice-money";
import { TERMS_LABELS, Usd } from "~/features/invoices/invoice-status";
import {
  useCustomers,
  useNextInvoiceNumber,
  useSaveInvoice,
  useSendInvoice,
} from "~/features/invoices/invoices-api";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { InlineCustomer } from "./customer-form";
import { InvoiceTotalsBlock } from "./invoice-totals";

const EMPTY_ERRORS: DraftErrors = { fields: {}, lines: {} };

/**
 * An invoice draft, new or edited (docs/decisions/crypto-invoicing.md): the
 * customer, number, dates and terms, lines in dollars, one optional tax and
 * a note. Totals follow as you type, worked out the way the API does.
 * "Save and send" saves, then sends; if sending fails, the draft is kept and
 * the next try saves it again before sending. The buttons sit in the side
 * sheet's footer (`footerSlot`).
 */
export function InvoiceForm({
  organizationId,
  invoice,
  footerSlot,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  /** The draft being edited; null for a new invoice. */
  invoice: Invoice | null;
  footerSlot: HTMLElement | null;
  onSaved: (invoice: Invoice) => void;
  onCancel: () => void;
}): JSX.Element {
  const uid = useId();
  const formId = `${uid}form`;
  const customers = useCustomers(organizationId, true);
  const nextNumber = useNextInvoiceNumber(organizationId, {
    enabled: invoice === null,
  });
  const save = useSaveInvoice(organizationId);
  const send = useSendInvoice(organizationId);
  const [draft, setDraft] = useState<InvoiceDraft>(() =>
    invoice
      ? draftFromInvoice(invoice)
      : blankDraft(nairobiIsoDate(new Date())),
  );
  const [errors, setErrors] = useState<DraftErrors>(EMPTY_ERRORS);
  const [savedId, setSavedId] = useState<string | null>(invoice?.id ?? null);
  const [added, setAdded] = useState<Customer | null>(null);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const busy = save.isPending || send.isPending;
  const number = draft.number ?? nextNumber.data ?? "";

  function change(changes: Partial<InvoiceDraft>) {
    save.reset();
    send.reset();
    setDraft((current) => ({ ...current, ...changes }));
  }

  function changeLine(
    key: string,
    changes: { description?: string; quantity?: string; unitPrice?: string },
  ) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.key === key ? { ...line, ...changes } : line,
      ),
    }));
    setErrors((current) => {
      const { [key]: _cleared, ...rest } = current.lines;
      return { ...current, lines: rest, linesSummary: undefined };
    });
  }

  function clearField(field: keyof DraftErrors["fields"]) {
    setErrors((current) => {
      const { [field]: _cleared, ...rest } = current.fields;
      return { ...current, fields: rest };
    });
  }

  function submit(andSend: boolean) {
    const result = toDraftRequest(draft, number);
    if (!result.ok) {
      setErrors(result.errors);
      focusFirstError(uid, draft, result.errors);
      return;
    }
    setErrors(EMPTY_ERRORS);
    save.mutate(
      { invoiceId: savedId, request: result.request },
      {
        onSuccess: (saved) => {
          setSavedId(saved.id);
          if (!andSend) {
            onSaved(saved);
            return;
          }
          send.mutate(saved.id, { onSuccess: onSaved });
        },
      },
    );
  }

  const taxBps =
    draft.taxRate.trim() === "" ? null : percentToBps(draft.taxRate);
  const totals = computeTotals(
    draft.lines.map((line) => ({
      quantity: line.quantity.trim(),
      unitPriceCents: dollarsToCents(line.unitPrice),
    })),
    taxBps,
  );
  const dueOn = dueDateOf(draft);
  const choices = customerChoices(customers.data, added, draft.customerId);
  const failure = save.isError
    ? describeApiError(save.error)
    : send.isError
      ? `Saved as a draft, but it wasn't sent: ${describeApiError(send.error)}`
      : null;
  const invalid = (field: keyof DraftErrors["fields"]) =>
    errors.fields[field] ? { "aria-invalid": true } : {};

  return (
    <>
      <form
        id={formId}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submit(false);
        }}
        noValidate
        aria-label={invoice ? "Edit invoice" : "New invoice"}
        className="flex flex-col gap-[18px]"
      >
        <Field>
          <FieldLabel htmlFor={`${uid}customer`}>Bill to</FieldLabel>
          <NativeSelect
            id={`${uid}customer`}
            className="w-full"
            value={draft.customerId ?? ""}
            onChange={(event) => {
              change({
                customerId:
                  event.target.value === "" ? null : event.target.value,
              });
              clearField("customer");
            }}
            disabled={busy || customers.isPending}
            {...invalid("customer")}
          >
            <NativeSelectOption value="">
              {customers.isPending ? "Loading customers…" : "Choose a customer"}
            </NativeSelectOption>
            {choices.map((customer) => (
              <NativeSelectOption key={customer.id} value={customer.id}>
                {customer.name} ({customer.email})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {errors.fields.customer ? (
            <FieldError>{errors.fields.customer}</FieldError>
          ) : null}
          {customers.isError ? (
            <FieldError>{describeApiError(customers.error)}</FieldError>
          ) : null}
          {addingCustomer ? null : (
            <FieldDescription>
              <TextLinkButton
                onClick={() => setAddingCustomer(true)}
                disabled={busy}
              >
                Add a new customer
              </TextLinkButton>
            </FieldDescription>
          )}
        </Field>
        {addingCustomer ? (
          <InlineCustomer
            organizationId={organizationId}
            onCancel={() => setAddingCustomer(false)}
            onCreated={(customer) => {
              setAdded(customer);
              change({ customerId: customer.id });
              clearField("customer");
              setAddingCustomer(false);
            }}
          />
        ) : null}

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={`${uid}number`}>Invoice number</FieldLabel>
            <Input
              id={`${uid}number`}
              value={number}
              onChange={(event) => {
                change({ number: event.target.value });
                clearField("number");
              }}
              autoComplete="off"
              disabled={busy}
              {...invalid("number")}
            />
            {errors.fields.number ? (
              <FieldError>{errors.fields.number}</FieldError>
            ) : (
              <FieldDescription>
                It locks when the invoice is sent.
              </FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}issueOn`}>Issue date</FieldLabel>
            <Input
              id={`${uid}issueOn`}
              type="date"
              value={draft.issueOn}
              onChange={(event) => {
                change({ issueOn: event.target.value });
                clearField("issueOn");
              }}
              disabled={busy}
              className="tabular-nums"
              {...invalid("issueOn")}
            />
            {errors.fields.issueOn ? (
              <FieldError>{errors.fields.issueOn}</FieldError>
            ) : null}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={`${uid}terms`}>Terms</FieldLabel>
            <NativeSelect
              id={`${uid}terms`}
              className="w-full"
              value={draft.terms}
              onChange={(event) => {
                const terms = INVOICE_TERMS.find(
                  (known) => known === event.target.value,
                );
                if (terms) change({ terms });
                clearField("terms");
                clearField("dueOn");
              }}
              disabled={busy}
              {...invalid("terms")}
            >
              {INVOICE_TERMS.map((terms) => (
                <NativeSelectOption key={terms} value={terms}>
                  {TERMS_LABELS[terms]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}dueOn`}>Due date</FieldLabel>
            {draft.terms === "custom" ? (
              <Input
                id={`${uid}dueOn`}
                type="date"
                value={draft.dueOn}
                min={draft.issueOn}
                onChange={(event) => {
                  change({ dueOn: event.target.value });
                  clearField("dueOn");
                }}
                disabled={busy}
                className="tabular-nums"
                {...invalid("dueOn")}
              />
            ) : (
              <p
                id={`${uid}dueOn`}
                className="flex h-11 items-center text-muted-foreground tabular-nums"
              >
                {dueOn ? formatIsoDate(dueOn) : "Choose an issue date"}
              </p>
            )}
            {errors.fields.dueOn ? (
              <FieldError>{errors.fields.dueOn}</FieldError>
            ) : null}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-(--w-ui)">Lines</legend>
          {draft.lines.map((line, index) => {
            const amount = totals.lineCents[index] ?? null;
            const lineError = errors.lines[line.key];
            return (
              <div
                key={line.key}
                role="group"
                aria-label={`Line ${String(index + 1)}`}
                className="flex flex-col gap-2 rounded-control border border-border p-3"
              >
                <Input
                  id={`${uid}${line.key}-description`}
                  aria-label={`Description, line ${String(index + 1)}`}
                  value={line.description}
                  onChange={(event) =>
                    changeLine(line.key, { description: event.target.value })
                  }
                  placeholder="What you are charging for"
                  disabled={busy}
                  aria-invalid={lineError ? true : undefined}
                />
                <div className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 max-[600px]:grid-cols-2">
                  <Input
                    id={`${uid}${line.key}-quantity`}
                    aria-label={`Quantity, line ${String(index + 1)}`}
                    value={line.quantity}
                    onChange={(event) =>
                      changeLine(line.key, { quantity: event.target.value })
                    }
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={busy}
                    className="tabular-nums"
                    aria-invalid={lineError ? true : undefined}
                  />
                  <Input
                    id={`${uid}${line.key}-price`}
                    aria-label={`Unit price in dollars, line ${String(index + 1)}`}
                    value={line.unitPrice}
                    onChange={(event) =>
                      changeLine(line.key, { unitPrice: event.target.value })
                    }
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    disabled={busy}
                    className="tabular-nums"
                    aria-invalid={lineError ? true : undefined}
                  />
                  <p
                    className="text-right text-muted-foreground"
                    aria-label={`Amount, line ${String(index + 1)}`}
                  >
                    {amount === null ? "–" : <Usd cents={amount} />}
                  </p>
                  <IconButton
                    label={`Remove line ${String(index + 1)}`}
                    disabled={busy || draft.lines.length === 1}
                    onClick={() =>
                      change({
                        lines: draft.lines.filter(
                          (other) => other.key !== line.key,
                        ),
                      })
                    }
                  >
                    <Trash2Icon aria-hidden="true" />
                  </IconButton>
                </div>
                {lineError ? <FieldError>{lineError}</FieldError> : null}
              </div>
            );
          })}
          {errors.linesSummary ? (
            <FieldError>{errors.linesSummary}</FieldError>
          ) : null}
          <div>
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={busy || draft.lines.length >= MAX_INVOICE_LINES}
              onClick={() => change({ lines: [...draft.lines, blankLine()] })}
            >
              <PlusIcon aria-hidden="true" />
              Add a line
            </Button>
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={`${uid}taxRate`}>
              Tax rate % (optional)
            </FieldLabel>
            <Input
              id={`${uid}taxRate`}
              value={draft.taxRate}
              onChange={(event) => {
                change({ taxRate: event.target.value });
                clearField("taxRate");
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder="16"
              disabled={busy}
              className="tabular-nums"
              {...invalid("taxRate")}
            />
            {errors.fields.taxRate ? (
              <FieldError>{errors.fields.taxRate}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}taxLabel`}>Tax name</FieldLabel>
            <Input
              id={`${uid}taxLabel`}
              value={draft.taxLabel}
              onChange={(event) => {
                change({ taxLabel: event.target.value });
                clearField("taxLabel");
              }}
              maxLength={20}
              disabled={busy}
              {...invalid("taxLabel")}
            />
            {errors.fields.taxLabel ? (
              <FieldError>{errors.fields.taxLabel}</FieldError>
            ) : null}
          </Field>
        </div>

        <InvoiceTotalsBlock
          subtotalCents={totals.subtotalCents}
          taxCents={totals.taxCents}
          taxLabel={draft.taxLabel.trim() || "Tax"}
          taxRatePercent={
            taxBps !== null && taxBps > 0 ? bpsToPercent(taxBps) : null
          }
          totalCents={totals.totalCents}
        />

        <Field>
          <FieldLabel htmlFor={`${uid}note`}>Note (optional)</FieldLabel>
          <Textarea
            id={`${uid}note`}
            value={draft.note}
            onChange={(event) => {
              change({ note: event.target.value });
              clearField("note");
            }}
            maxLength={2000}
            rows={3}
            placeholder="Payment instructions, thanks, PO number"
            disabled={busy}
            {...invalid("note")}
          />
          {errors.fields.note ? (
            <FieldError>{errors.fields.note}</FieldError>
          ) : null}
        </Field>

        {errors.form ? (
          <Callout tone="error">
            <p>{errors.form}</p>
          </Callout>
        ) : null}
        {failure ? (
          <Callout tone="error">
            <p role="alert">{failure}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button type="button" disabled={busy} onClick={() => submit(true)}>
          {send.isPending ? "Sending…" : "Save and send"}
        </Button>
        <Button type="submit" form={formId} variant="outline" disabled={busy}>
          {save.isPending && !send.isPending ? "Saving…" : "Save draft"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
      </SheetFooterPortal>
    </>
  );
}

function customerChoices(
  listed: readonly Customer[] | undefined,
  added: Customer | null,
  chosenId: string | null,
): Customer[] {
  const customers = [...(listed ?? [])];
  if (added && !customers.some((customer) => customer.id === added.id)) {
    customers.push(added);
  }
  return customers
    .filter((customer) => !customer.archived || customer.id === chosenId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function focusFirstError(
  uid: string,
  draft: InvoiceDraft,
  errors: DraftErrors,
): void {
  const order: (readonly [boolean, string])[] = [
    [errors.fields.customer !== undefined, "customer"],
    [errors.fields.number !== undefined, "number"],
    [errors.fields.issueOn !== undefined, "issueOn"],
    [errors.fields.terms !== undefined, "terms"],
    [errors.fields.dueOn !== undefined, "dueOn"],
    ...draft.lines.map(
      (line) =>
        [errors.lines[line.key] !== undefined, `${line.key}-price`] as const,
    ),
    [errors.fields.taxRate !== undefined, "taxRate"],
    [errors.fields.taxLabel !== undefined, "taxLabel"],
    [errors.fields.note !== undefined, "note"],
  ];
  const first = order.find(([failed]) => failed);
  if (first) document.getElementById(`${uid}${first[1]}`)?.focus();
}
