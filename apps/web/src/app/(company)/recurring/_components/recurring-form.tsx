"use client";

import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type {
  CreateRecurringItemRequest,
  Payee,
  PayeeKind,
  RecurringItem,
  RecurringPayVia,
  RecurringSchedule,
  UpdateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  BILL_HEADINGS,
  createRecurringItemRequestSchema,
  defaultBillHeading,
  describeSchedule,
  maxScheduleDay,
  RECURRING_SCHEDULES,
  REMINDER_DAYS_MAX,
  updateRecurringItemRequestSchema,
  WEEKDAY_NAMES,
} from "@expendi-business/shared";

import type { RecurringDraft } from "~/features/recurring/recurring-draft";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { CURRENCY_LABELS, currencyOfPayee } from "~/features/bills/bill-amount";
import { HEADING_LABELS } from "~/features/bills/bill-status";
import { KIND_LABELS } from "~/features/payees/payee-display";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import { Field } from "~/features/payment-ui";
import {
  defaultScheduleDay,
  scheduleInWords,
  toCreateRequest,
  toUpdateRequest,
} from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { queryKeys } from "~/lib/query-keys";

type ErrorField =
  | "payeeId"
  | "amount"
  | "schedule"
  | "scheduleDay"
  | "startsOn"
  | "endsOn"
  | "payVia"
  | "reminderDays"
  | "heading"
  | "categoryId"
  | "form";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Readonly<Record<string, ErrorField>> = {
  payeeId: "payeeId",
  amountKes: "amount",
  amountUsd: "amount",
  schedule: "schedule",
  scheduleDay: "scheduleDay",
  startsOn: "startsOn",
  endsOn: "endsOn",
  payVia: "payVia",
  reminderDays: "reminderDays",
  overviewHeading: "heading",
  categoryId: "categoryId",
};

function fieldErrorsOf(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    const field =
      (typeof key === "string" ? ERROR_FIELDS[key] : undefined) ?? "form";
    errors[field] ??= issue.message;
  }
  return errors;
}

const SCHEDULE_LABELS: Record<RecurringSchedule, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly, counted from the start date’s month",
  yearly: "Yearly, in the start date’s month",
};

export const PAY_VIA_LABELS: Record<RecurringPayVia, string> = {
  expendi: "Through Expendi",
  outside: "Outside Expendi",
};

function FieldError({ message }: { message: string | undefined }) {
  return message ? (
    <p className="mt-1 text-sm text-error-700">{message}</p>
  ) : null;
}

type RecurringFormProps = {
  organizationId: string;
  initialDraft: RecurringDraft;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
  onCancel: () => void;
} & (
  | {
      /** A new recurring payment; its first bill is created with it. */
      item?: undefined;
      onSubmit: (request: CreateRecurringItemRequest) => void;
    }
  | {
      /** The payment being changed; only what changed is sent. */
      item: RecurringItem;
      onSubmit: (request: UpdateRecurringItemRequest) => void;
    }
);

/**
 * The new and edit recurring payment form (spec §6.20), as the app has it
 * (`apps/mobile/src/features/recurring/recurring-form.tsx`). The payee,
 * schedule, start date and how it's paid are set once; changes apply to
 * bills still to come.
 */
export function RecurringForm(props: RecurringFormProps): JSX.Element {
  const {
    organizationId,
    initialDraft,
    submitLabel,
    submitting,
    submitError,
    onCancel,
  } = props;
  const [draft, setDraft] = useState<RecurringDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [payeeKind, setPayeeKind] = useState<PayeeKind | null>(
    props.item?.payee.kind ?? null,
  );
  const [payeeOutside, setPayeeOutside] = useState(false);
  const unchanged =
    props.item !== undefined &&
    Object.keys(toUpdateRequest(props.item, draft)).length === 0;

  function update<K extends keyof RecurringDraft>(
    field: K,
    value: RecurringDraft[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function choosePayee(payee: Pick<Payee, "id" | "kind" | "details">) {
    const currency = currencyOfPayee(payee.details?.method, "kes");
    const outside = payee.details?.method === "outside";
    setPayeeKind(payee.kind);
    setPayeeOutside(outside);
    setDraft((current) => ({
      ...current,
      payeeId: payee.id,
      ...(currency !== current.currency && { currency, amount: "" }),
      ...(outside && { payVia: "outside" as const }),
    }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.item === undefined) {
      const request = toCreateRequest(draft);
      const parsed = createRecurringItemRequestSchema.safeParse(request);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsOf(parsed.error.issues));
        return;
      }
      setFieldErrors({});
      props.onSubmit(request);
      return;
    }
    const request = toUpdateRequest(props.item, draft);
    const parsed = updateRecurringItemRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsOf(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    props.onSubmit(request);
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={
        props.item ? "Edit recurring payment" : "New recurring payment"
      }
      className="space-y-4"
    >
      {props.item ? (
        <SetOnce item={props.item} />
      ) : (
        <PayeeSelect
          organizationId={organizationId}
          value={draft.payeeId}
          onChange={choosePayee}
          error={fieldErrors.payeeId}
        />
      )}

      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.variable}
            onChange={(event) => update("variable", event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Variable amount
            <span className="block text-xs text-stone-500">
              Entered on each bill, e.g. PAYE or electricity.
            </span>
          </span>
        </label>
        {draft.variable ? null : (
          <label className="mt-3 block text-sm">
            Amount ({CURRENCY_LABELS[draft.currency]})
            <input
              type="text"
              inputMode="decimal"
              value={draft.amount}
              onChange={(event) => update("amount", event.target.value)}
              placeholder={draft.currency === "usd" ? "120.00" : "45,000.00"}
              className={inputClass}
            />
          </label>
        )}
        {draft.currency === "usd" ? (
          <p className="mt-1 text-xs text-stone-500">
            This payee is paid in USDC: each bill pays exactly this many USDC.
          </p>
        ) : null}
        {props.item ? (
          <p className="mt-1 text-xs text-stone-500">
            A new amount applies from the next bill. To change the bill already
            created, edit that bill.
          </p>
        ) : null}
        <FieldError message={fieldErrors.amount} />
      </div>

      {props.item ? null : (
        <ScheduleFields
          draft={draft}
          errors={fieldErrors}
          onChange={(changes) =>
            setDraft((current) => ({ ...current, ...changes }))
          }
        />
      )}

      <label className="block text-sm">
        End date (optional)
        <input
          type="date"
          value={draft.endsOn}
          onChange={(event) => update("endsOn", event.target.value)}
          className={inputClass}
        />
        <FieldError message={fieldErrors.endsOn} />
      </label>

      {props.item ? null : (
        <label className="block text-sm">
          How it’s paid
          <select
            value={draft.payVia}
            onChange={(event) =>
              update(
                "payVia",
                event.target.value === "outside" ? "outside" : "expendi",
              )
            }
            className={inputClass}
          >
            <option value="expendi" disabled={payeeOutside}>
              {PAY_VIA_LABELS.expendi}: you pay each bill from the wallet
            </option>
            <option value="outside">
              {PAY_VIA_LABELS.outside}: e.g. by card; you mark each bill paid
            </option>
          </select>
          {payeeOutside ? (
            <span className="mt-1 block text-xs text-stone-500">
              This payee is paid outside Expendi.
            </span>
          ) : null}
          <FieldError message={fieldErrors.payVia} />
        </label>
      )}

      <label className="block text-sm">
        Remind admins (days before it’s due)
        <input
          type="number"
          min={0}
          max={REMINDER_DAYS_MAX}
          value={draft.reminderDays}
          onChange={(event) => update("reminderDays", event.target.value)}
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-stone-500">
          Up to {String(REMINDER_DAYS_MAX)} days. Admins are also reminded on
          the due date, and once if it’s overdue.
        </span>
        <FieldError message={fieldErrors.reminderDays} />
      </label>

      <label className="block text-sm">
        Overview heading
        <select
          value={
            draft.heading ??
            (payeeKind ? defaultBillHeading(payeeKind) : "transactions")
          }
          onChange={(event) => {
            const heading = BILL_HEADINGS.find(
              (option) => option === event.target.value,
            );
            if (heading) update("heading", heading);
          }}
          className={inputClass}
        >
          {BILL_HEADINGS.map((heading) => (
            <option key={heading} value={heading}>
              {HEADING_LABELS[heading]}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors.heading} />
      </label>

      <CategorySelect
        organizationId={organizationId}
        current={props.item?.category}
        value={draft.categoryId}
        onChange={(categoryId) => update("categoryId", categoryId)}
        error={fieldErrors.categoryId}
      />

      {fieldErrors.form ? (
        <p className={alertClass} role="alert">
          {fieldErrors.form}
        </p>
      ) : null}
      {submitError ? (
        <p className={alertClass} role="alert">
          {describeApiError(submitError)}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || unchanged}
          className={primaryButton}
        >
          {submitting ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What can't change once the payment is set up. */
function SetOnce({ item }: { item: RecurringItem }): JSX.Element {
  return (
    <div className="rounded-md bg-stone-50 p-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="Pay to">{item.payee.name}</Field>
        <Field label="When">{scheduleInWords(item)}</Field>
        <Field label="Starts">{formatIsoDate(item.startsOn)}</Field>
        <Field label="How it’s paid">{PAY_VIA_LABELS[item.payVia]}</Field>
      </dl>
      <p className="mt-3 text-xs text-stone-500">
        To change who it’s paid to, when, or how, end this payment and set up a
        new one.
      </p>
    </div>
  );
}

function ScheduleFields({
  draft,
  errors,
  onChange,
}: {
  draft: RecurringDraft;
  errors: FieldErrors;
  onChange: (changes: Partial<RecurringDraft>) => void;
}): JSX.Element {
  const day = Number(draft.scheduleDay);
  const validDay =
    Number.isInteger(day) && day >= 1 && day <= maxScheduleDay(draft.schedule);
  const validStart = /^\d{4}-\d{2}-\d{2}$/.test(draft.startsOn.trim());

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="block text-sm">
        How often
        <select
          value={draft.schedule}
          onChange={(event) => {
            const schedule = RECURRING_SCHEDULES.find(
              (option) => option === event.target.value,
            );
            if (!schedule) return;
            onChange({
              schedule,
              scheduleDay: validStart
                ? defaultScheduleDay(schedule, draft.startsOn.trim())
                : "",
            });
          }}
          className={inputClass}
        >
          {RECURRING_SCHEDULES.map((schedule) => (
            <option key={schedule} value={schedule}>
              {SCHEDULE_LABELS[schedule]}
            </option>
          ))}
        </select>
        <FieldError message={errors.schedule} />
      </label>

      <label className="block text-sm">
        Start date
        <input
          type="date"
          value={draft.startsOn}
          onChange={(event) => onChange({ startsOn: event.target.value })}
          className={inputClass}
        />
        <FieldError message={errors.startsOn} />
      </label>

      {draft.schedule === "weekly" ? (
        <label className="block text-sm">
          Due every
          <select
            value={draft.scheduleDay}
            onChange={(event) => onChange({ scheduleDay: event.target.value })}
            className={inputClass}
          >
            {WEEKDAY_NAMES.map((name, index) => (
              <option key={name} value={String(index + 1)}>
                {name}
              </option>
            ))}
          </select>
          <FieldError message={errors.scheduleDay} />
        </label>
      ) : (
        <label className="block text-sm">
          Day of the month it’s due (1–31)
          <input
            type="number"
            min={1}
            max={31}
            value={draft.scheduleDay}
            onChange={(event) => onChange({ scheduleDay: event.target.value })}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-stone-500">
            In a shorter month, it’s due on the month’s last day.
          </span>
          <FieldError message={errors.scheduleDay} />
        </label>
      )}

      {validDay && validStart ? (
        <p className="self-end text-sm text-stone-700">
          Due: {describeSchedule(draft.schedule, day, draft.startsOn.trim())}
        </p>
      ) : null}
    </div>
  );
}

function PayeeSelect({
  organizationId,
  value,
  onChange,
  error,
}: {
  organizationId: string;
  value: string | null;
  onChange: (payee: Payee) => void;
  error: string | undefined;
}): JSX.Element {
  const payees = usePayees(organizationId, ACTIVE_PAYEES);

  if (payees.isPending) {
    return <p className="text-sm text-stone-500">Loading payees…</p>;
  }
  if (payees.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(payees.error)}</p>
        <button
          type="button"
          onClick={() => void payees.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Load payees again
        </button>
      </div>
    );
  }
  if (payees.data.length === 0) {
    return (
      <p className="text-sm text-stone-600">
        Add the payee under Payees first, then come back to set up the payment.
      </p>
    );
  }
  return (
    <label className="block text-sm">
      Pay to
      <select
        value={value ?? ""}
        onChange={(event) => {
          const picked = payees.data.find(
            (payee) => payee.id === event.target.value,
          );
          if (picked) onChange(picked);
        }}
        className={inputClass}
      >
        <option value="" disabled>
          Choose a payee
        </option>
        {payees.data.map((payee) => (
          <option key={payee.id} value={payee.id}>
            {payee.name} · {KIND_LABELS[payee.kind]}
            {payee.details?.method === "outside"
              ? " · Paid outside Expendi"
              : ""}
          </option>
        ))}
      </select>
      <FieldError message={error} />
    </label>
  );
}

function CategorySelect({
  organizationId,
  current,
  value,
  onChange,
  error,
}: {
  organizationId: string;
  current: RecurringItem["category"] | undefined;
  value: string | null;
  onChange: (categoryId: string) => void;
  error: string | undefined;
}): JSX.Element {
  const { api } = useAuth();
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });

  if (categories.isPending) {
    return <p className="text-sm text-stone-500">Loading categories…</p>;
  }
  if (categories.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(categories.error)}</p>
        <button
          type="button"
          onClick={() => void categories.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Load categories again
        </button>
      </div>
    );
  }
  const choices =
    current && !categories.data.some((category) => category.id === current.id)
      ? [...categories.data, current]
      : categories.data;
  return (
    <label className="block text-sm">
      Category
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        <option value="" disabled>
          Choose a category
        </option>
        {choices.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      <FieldError message={error} />
    </label>
  );
}
