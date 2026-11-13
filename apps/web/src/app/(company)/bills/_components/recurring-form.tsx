"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import type {
  CreateRecurringItemRequest,
  Payee,
  PayeeKind,
  PayeeMethod,
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
import { textLinkClass } from "~/components/data/actions";
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
import { useAuth } from "~/contexts/auth-context";
import { CURRENCY_LABELS, currencyOfPayee } from "~/features/bills/bill-amount";
import { HEADING_LABELS, headingLabel } from "~/features/bills/bill-status";
import { useCashOutLimits } from "~/features/bills/bills-api";
import {
  limitsForPayee,
  serverFieldIssues,
  smallestAmountHint,
  typedAmountProblem,
} from "~/features/bills/cash-out-limits";
import { KIND_LABELS } from "~/features/payees/payee-display";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import {
  defaultScheduleDay,
  firstDueOn,
  scheduleInWords,
  toCreateRequest,
  toUpdateRequest,
} from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { queryKeys } from "~/lib/query-keys";
import { fieldErrorsOf, focusFirstError } from "./form-errors";
import { Note } from "./note";
import { SheetFooterPortal } from "./sheet-footer";

type RecurringField =
  | "payeeId"
  | "amount"
  | "schedule"
  | "startsOn"
  | "scheduleDay"
  | "endsOn"
  | "payVia"
  | "reminderDays"
  | "heading"
  | "categoryId";
type FieldErrors = Partial<Record<RecurringField | "form", string>>;

const REQUEST_FIELDS: Readonly<Record<string, RecurringField>> = {
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

const FIELD_ORDER: readonly RecurringField[] = [
  "payeeId",
  "amount",
  "schedule",
  "startsOn",
  "scheduleDay",
  "endsOn",
  "payVia",
  "reminderDays",
  "heading",
  "categoryId",
];

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type RecurringFormProps = {
  organizationId: string;
  initialDraft: RecurringDraft;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
  /** The side sheet's footer, where the buttons go. */
  footerSlot: HTMLElement | null;
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
    footerSlot,
    onCancel,
  } = props;
  const uid = useId();
  const idOf = (field: RecurringField) => `${uid}${field}`;
  const [draft, setDraft] = useState<RecurringDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [payeeKind, setPayeeKind] = useState<PayeeKind | null>(
    props.item?.payee.kind ?? null,
  );
  const [payeeOutside, setPayeeOutside] = useState(false);
  const [payeeMethod, setPayeeMethod] = useState<PayeeMethod | null>(
    props.item?.payee.method ?? null,
  );
  /** The save error last seen before an edit: its field message no longer applies. */
  const [editedSince, setEditedSince] = useState<unknown>(null);
  const cashOutLimits = useCashOutLimits(organizationId);
  const amountLimits =
    draft.payVia === "expendi" && !draft.variable
      ? limitsForPayee(payeeMethod, cashOutLimits)
      : null;
  const amountHint = smallestAmountHint(amountLimits);
  const unchanged =
    props.item !== undefined &&
    Object.keys(toUpdateRequest(props.item, draft)).length === 0;

  function update(changes: Partial<RecurringDraft>, field: RecurringField) {
    setEditedSince(submitError);
    setDraft((current) => ({ ...current, ...changes }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function choosePayee(payee: Pick<Payee, "id" | "kind" | "details">) {
    const currency = currencyOfPayee(payee.details?.method, "kes");
    const outside = payee.details?.method === "outside";
    setPayeeKind(payee.kind);
    setPayeeOutside(outside);
    setPayeeMethod(payee.details?.method ?? null);
    update(
      {
        payeeId: payee.id,
        ...(currency !== draft.currency && { currency, amount: "" }),
        ...(outside && { payVia: "outside" as const }),
      },
      "payeeId",
    );
  }

  function invalid(
    issues: readonly { path: readonly PropertyKey[]; message: string }[],
  ) {
    const found = fieldErrorsOf(issues, REQUEST_FIELDS);
    setFieldErrors(found);
    focusFirstError(
      FIELD_ORDER.map((field) => ({ field, id: idOf(field) })),
      found,
    );
  }

  /** A cash-out amount out of range, judged as the API does: on any new amount. */
  function amountProblem(amountChanged: boolean): boolean {
    const problem = amountChanged
      ? typedAmountProblem(draft.amount, amountLimits)
      : null;
    if (problem !== null) invalid([{ path: ["amountKes"], message: problem }]);
    return problem !== null;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.item === undefined) {
      const request = toCreateRequest(draft);
      const parsed = createRecurringItemRequestSchema.safeParse(request);
      if (!parsed.success) {
        invalid(parsed.error.issues);
        return;
      }
      if (amountProblem(true)) return;
      setFieldErrors({});
      props.onSubmit(request);
      return;
    }
    const request = toUpdateRequest(props.item, draft);
    const parsed = updateRecurringItemRequestSchema.safeParse(request);
    if (!parsed.success) {
      invalid(parsed.error.issues);
      return;
    }
    if (amountProblem(request.amountKes !== undefined)) return;
    setFieldErrors({});
    props.onSubmit(request);
  }

  const amountShown = !draft.variable;
  const serverIssues = serverFieldIssues(submitError, REQUEST_FIELDS);
  const serverErrors: FieldErrors =
    submitError === editedSince
      ? {}
      : fieldErrorsOf(serverIssues, REQUEST_FIELDS);
  const shownErrors: FieldErrors = { ...serverErrors, ...fieldErrors };
  const invalidProps = (field: RecurringField) =>
    shownErrors[field] ? { "aria-invalid": true } : {};
  const errorOf = (field: RecurringField) =>
    shownErrors[field] ? <FieldError>{shownErrors[field]}</FieldError> : null;

  const endsField = (
    <Field>
      <FieldLabel htmlFor={idOf("endsOn")}>End date (optional)</FieldLabel>
      <Input
        id={idOf("endsOn")}
        type="date"
        value={draft.endsOn}
        onChange={(event) => update({ endsOn: event.target.value }, "endsOn")}
        className="tabular-nums"
        {...invalidProps("endsOn")}
      />
      <FieldDescription>Leave blank to keep going.</FieldDescription>
      {errorOf("endsOn")}
    </Field>
  );

  return (
    <>
      <form
        id={`${uid}form`}
        onSubmit={onSubmit}
        noValidate
        aria-label={
          props.item ? "Edit recurring payment" : "New recurring payment"
        }
        className="flex flex-col gap-[18px]"
      >
        <Note>
          {props.item
            ? `Changes apply to the bills still to come. The overview heading follows the payee (${headingLabel(defaultBillHeading(props.item.payee.kind))}) unless you pick another.`
            : "Its first bill is created now and shows in To pay."}
        </Note>

        {props.item ? (
          <SetOnce item={props.item} />
        ) : (
          <Field>
            <FieldLabel htmlFor={idOf("payeeId")}>Pay to</FieldLabel>
            <PayeeSelect
              id={idOf("payeeId")}
              organizationId={organizationId}
              value={draft.payeeId}
              invalid={shownErrors.payeeId !== undefined}
              onChange={choosePayee}
            />
            {errorOf("payeeId")}
          </Field>
        )}

        <label className="flex cursor-pointer items-start gap-2.5">
          <RowCheckbox
            className="mt-px"
            checked={draft.variable}
            onChange={(event) =>
              update({ variable: event.target.checked }, "amount")
            }
          />
          <span>
            <span className="block text-sm font-(--w-ui) text-foreground">
              Variable amount
            </span>
            <span className="block text-xs leading-4 text-muted-foreground">
              Entered on each bill, e.g. PAYE or electricity.
            </span>
          </span>
        </label>

        {amountShown ? (
          <Field>
            <FieldLabel htmlFor={idOf("amount")}>
              Amount ({CURRENCY_LABELS[draft.currency]})
            </FieldLabel>
            <Input
              id={idOf("amount")}
              inputMode="decimal"
              autoComplete="off"
              value={draft.amount}
              onChange={(event) =>
                update({ amount: event.target.value }, "amount")
              }
              placeholder={draft.currency === "usd" ? "120.00" : "45,000.00"}
              className="tabular-nums"
              {...invalidProps("amount")}
            />
            {draft.currency === "usd" ? (
              <FieldDescription>
                This payee is paid in USDC: each bill pays exactly this many
                USDC.
              </FieldDescription>
            ) : null}
            {amountHint ? (
              <FieldDescription>{amountHint}</FieldDescription>
            ) : null}
            {props.item ? (
              <FieldDescription>
                A new amount applies from the next bill. To change the bill
                already created, edit that bill.
              </FieldDescription>
            ) : null}
            {errorOf("amount")}
          </Field>
        ) : null}

        {props.item ? (
          endsField
        ) : (
          <ScheduleFields
            draft={draft}
            idOf={idOf}
            errorOf={errorOf}
            invalidProps={invalidProps}
            onChange={update}
            endsField={endsField}
          />
        )}

        {props.item ? null : (
          <Field>
            <FieldLabel htmlFor={idOf("payVia")}>How it’s paid</FieldLabel>
            <NativeSelect
              id={idOf("payVia")}
              className="w-full"
              value={draft.payVia}
              onChange={(event) =>
                update(
                  {
                    payVia:
                      event.target.value === "outside" ? "outside" : "expendi",
                  },
                  "payVia",
                )
              }
              {...invalidProps("payVia")}
            >
              <NativeSelectOption value="expendi" disabled={payeeOutside}>
                {PAY_VIA_LABELS.expendi}: you pay each bill from the wallet
              </NativeSelectOption>
              <NativeSelectOption value="outside">
                {PAY_VIA_LABELS.outside}: e.g. by card; you mark each bill paid
              </NativeSelectOption>
            </NativeSelect>
            {payeeOutside ? (
              <FieldDescription>
                This payee is paid outside Expendi.
              </FieldDescription>
            ) : null}
            {errorOf("payVia")}
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field>
            <FieldLabel htmlFor={idOf("reminderDays")}>
              Remind admins (days before it’s due)
            </FieldLabel>
            <Input
              id={idOf("reminderDays")}
              type="number"
              inputMode="numeric"
              min={0}
              max={REMINDER_DAYS_MAX}
              value={draft.reminderDays}
              onChange={(event) =>
                update({ reminderDays: event.target.value }, "reminderDays")
              }
              className="tabular-nums"
              {...invalidProps("reminderDays")}
            />
            <FieldDescription>
              Up to {String(REMINDER_DAYS_MAX)} days. Admins are also reminded
              on the due date, and once if it’s overdue.
            </FieldDescription>
            {errorOf("reminderDays")}
          </Field>
          <Field>
            <FieldLabel htmlFor={idOf("heading")}>Overview heading</FieldLabel>
            <NativeSelect
              id={idOf("heading")}
              className="w-full"
              value={
                draft.heading ??
                (payeeKind ? defaultBillHeading(payeeKind) : "transactions")
              }
              onChange={(event) => {
                const heading = BILL_HEADINGS.find(
                  (option) => option === event.target.value,
                );
                if (heading) update({ heading }, "heading");
              }}
              {...invalidProps("heading")}
            >
              {BILL_HEADINGS.map((heading) => (
                <NativeSelectOption key={heading} value={heading}>
                  {HEADING_LABELS[heading]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {errorOf("heading")}
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={idOf("categoryId")}>Category</FieldLabel>
          <CategorySelect
            id={idOf("categoryId")}
            organizationId={organizationId}
            current={props.item?.category}
            value={draft.categoryId}
            invalid={shownErrors.categoryId !== undefined}
            onChange={(categoryId) => update({ categoryId }, "categoryId")}
          />
          {errorOf("categoryId")}
        </Field>

        {fieldErrors.form ? (
          <Callout tone="error">
            <p role="alert">{fieldErrors.form}</p>
          </Callout>
        ) : null}
        {submitError && serverIssues.length === 0 ? (
          <Callout tone="error">
            <p role="alert">{describeApiError(submitError)}</p>
          </Callout>
        ) : null}
      </form>
      <SheetFooterPortal slot={footerSlot}>
        <Button
          type="submit"
          form={`${uid}form`}
          disabled={submitting || unchanged}
        >
          {submitting ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </SheetFooterPortal>
    </>
  );
}

/** What can't change once the payment is set up. */
function SetOnce({ item }: { item: RecurringItem }): JSX.Element {
  const rows = [
    ["Pay to", item.payee.name],
    ["When", scheduleInWords(item)],
    ["Starts", formatIsoDate(item.startsOn)],
    ["How it’s paid", PAY_VIA_LABELS[item.payVia]],
  ] as const;
  return (
    <div className="flex flex-col gap-3 rounded-control bg-muted/60 px-4 py-3.5">
      <dl className="flex flex-col">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-t border-border py-[9px] first:border-t-0 first:pt-0 max-[600px]:grid-cols-[minmax(0,1fr)] max-[600px]:gap-0.5"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="[overflow-wrap:anywhere] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <FieldDescription>
        To change who it’s paid to, when, or how, end this payment and set up a
        new one.
      </FieldDescription>
    </div>
  );
}

function ScheduleFields({
  draft,
  idOf,
  errorOf,
  invalidProps,
  onChange,
  endsField,
}: {
  draft: RecurringDraft;
  idOf: (field: RecurringField) => string;
  errorOf: (field: RecurringField) => ReactNode;
  invalidProps: (field: RecurringField) => { "aria-invalid"?: boolean };
  onChange: (changes: Partial<RecurringDraft>, field: RecurringField) => void;
  endsField: ReactNode;
}): JSX.Element {
  const day = Number(draft.scheduleDay);
  const validDay =
    /^\d+$/.test(draft.scheduleDay.trim()) &&
    day >= 1 &&
    day <= maxScheduleDay(draft.schedule);
  const startsOn = draft.startsOn.trim();
  const validStart = ISO_DATE.test(startsOn);
  const firstDue =
    validDay && validStart
      ? firstDueOn({
          schedule: draft.schedule,
          scheduleDay: day,
          startsOn,
          endsOn: ISO_DATE.test(draft.endsOn) ? draft.endsOn : null,
        })
      : null;

  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
        <Field>
          <FieldLabel htmlFor={idOf("schedule")}>How often</FieldLabel>
          <NativeSelect
            id={idOf("schedule")}
            className="w-full"
            value={draft.schedule}
            onChange={(event) => {
              const schedule = RECURRING_SCHEDULES.find(
                (option) => option === event.target.value,
              );
              if (!schedule) return;
              onChange(
                {
                  schedule,
                  scheduleDay: validStart
                    ? defaultScheduleDay(schedule, startsOn)
                    : "",
                },
                "schedule",
              );
            }}
            {...invalidProps("schedule")}
          >
            {RECURRING_SCHEDULES.map((schedule) => (
              <NativeSelectOption key={schedule} value={schedule}>
                {SCHEDULE_LABELS[schedule]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {errorOf("schedule")}
        </Field>
        <Field>
          <FieldLabel htmlFor={idOf("startsOn")}>Start date</FieldLabel>
          <Input
            id={idOf("startsOn")}
            type="date"
            value={draft.startsOn}
            onChange={(event) =>
              onChange({ startsOn: event.target.value }, "startsOn")
            }
            className="tabular-nums"
            {...invalidProps("startsOn")}
          />
          {errorOf("startsOn")}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
        {draft.schedule === "weekly" ? (
          <Field>
            <FieldLabel htmlFor={idOf("scheduleDay")}>Due every</FieldLabel>
            <NativeSelect
              id={idOf("scheduleDay")}
              className="w-full"
              value={draft.scheduleDay}
              onChange={(event) =>
                onChange({ scheduleDay: event.target.value }, "scheduleDay")
              }
              {...invalidProps("scheduleDay")}
            >
              {WEEKDAY_NAMES.map((name, index) => (
                <NativeSelectOption key={name} value={String(index + 1)}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {errorOf("scheduleDay")}
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor={idOf("scheduleDay")}>
              Day of the month it’s due (1 to 31)
            </FieldLabel>
            <Input
              id={idOf("scheduleDay")}
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={draft.scheduleDay}
              onChange={(event) =>
                onChange({ scheduleDay: event.target.value }, "scheduleDay")
              }
              className="tabular-nums"
              {...invalidProps("scheduleDay")}
            />
            <FieldDescription>
              In a shorter month, it’s due on the month’s last day.
            </FieldDescription>
            {errorOf("scheduleDay")}
          </Field>
        )}
        {endsField}
      </div>
      {validDay && validStart ? (
        <div
          aria-live="polite"
          className="flex items-start gap-2 rounded-control bg-muted/60 px-3 py-2.5"
        >
          <CalendarIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div>
            <strong className="block font-(--w-ui)">
              Due: {describeSchedule(draft.schedule, day, startsOn)}
            </strong>
            {firstDue ? (
              <span className="block text-xs leading-4 text-muted-foreground tabular-nums">
                First bill due {formatIsoDate(firstDue)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function LoadAgain({
  error,
  label,
  onRetry,
}: {
  error: unknown;
  label: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div role="alert">
      <Callout
        tone="error"
        action={
          <Button variant="outline" size="md" onClick={onRetry}>
            {label}
          </Button>
        }
      >
        <p>{describeApiError(error)}</p>
      </Callout>
    </div>
  );
}

function PayeeSelect({
  id,
  organizationId,
  value,
  invalid,
  onChange,
}: {
  id: string;
  organizationId: string;
  value: string | null;
  invalid: boolean;
  onChange: (payee: Payee) => void;
}): JSX.Element {
  const payees = usePayees(organizationId, ACTIVE_PAYEES);

  if (payees.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading payees…
      </p>
    );
  }
  if (payees.isError) {
    return (
      <LoadAgain
        error={payees.error}
        label="Load payees again"
        onRetry={() => void payees.refetch()}
      />
    );
  }
  const choices = payees.data
    .filter((payee) => payee.kind !== "employee")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (choices.length === 0) {
    return (
      <FieldDescription>
        Add the payee under{" "}
        <Link href="/payees" className={textLinkClass}>
          Payees
        </Link>{" "}
        first, then come back to set up the payment.
      </FieldDescription>
    );
  }
  return (
    <NativeSelect
      id={id}
      className="w-full"
      value={value ?? ""}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        const picked = choices.find((payee) => payee.id === event.target.value);
        if (picked) onChange(picked);
      }}
    >
      <NativeSelectOption value="" disabled>
        Choose a payee
      </NativeSelectOption>
      {choices.map((payee) => (
        <NativeSelectOption key={payee.id} value={payee.id}>
          {payee.name} · {KIND_LABELS[payee.kind]}
          {payee.details?.method === "outside" ? ", paid outside Expendi" : ""}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function CategorySelect({
  id,
  organizationId,
  current,
  value,
  invalid,
  onChange,
}: {
  id: string;
  organizationId: string;
  current: RecurringItem["category"] | undefined;
  value: string | null;
  invalid: boolean;
  onChange: (categoryId: string) => void;
}): JSX.Element {
  const { api } = useAuth();
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });

  if (categories.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading categories…
      </p>
    );
  }
  if (categories.isError) {
    return (
      <LoadAgain
        error={categories.error}
        label="Load categories again"
        onRetry={() => void categories.refetch()}
      />
    );
  }
  const choices =
    current && !categories.data.some((category) => category.id === current.id)
      ? [...categories.data, current]
      : categories.data;
  return (
    <NativeSelect
      id={id}
      className="w-full"
      value={value ?? ""}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
    >
      <NativeSelectOption value="" disabled>
        Choose a category
      </NativeSelectOption>
      {choices.map((category) => (
        <NativeSelectOption key={category.id} value={category.id}>
          {category.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
