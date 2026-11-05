import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  BillHeading,
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
  REMINDER_DAYS_MAX,
  updateRecurringItemRequestSchema,
  WEEKDAY_NAMES,
} from "@expendi-business/shared";

import type { RecurringDraft } from "./recurring-draft";
import type { PickerOption } from "~/components/option-picker";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { CURRENCY_LABELS, currencyOfPayee } from "~/features/bills/bill-amount";
import { HEADING_LABELS } from "~/features/bills/bill-status";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import { useCategories } from "~/features/claims/use-claims";
import { KIND_LABELS } from "~/features/payees/payee-display";
import { usePayees } from "~/features/payees/use-payees";
import { describeApiError } from "~/lib/api";
import {
  defaultScheduleDay,
  scheduleInWords,
  toCreateRequest,
  toUpdateRequest,
} from "./recurring-draft";

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
  | "categoryId";
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
    const field = typeof key === "string" ? ERROR_FIELDS[key] : undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

const AMOUNT_OPTIONS: PickerOption<"fixed" | "variable">[] = [
  {
    value: "fixed",
    label: "Fixed amount",
    description: "The same every time.",
  },
  {
    value: "variable",
    label: "Variable",
    description: "Entered on each bill, e.g. PAYE or electricity.",
  },
];

const SCHEDULE_OPTIONS: PickerOption<RecurringSchedule>[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  {
    value: "quarterly",
    label: "Quarterly",
    description: "Every 3 months, counted from the start date’s month.",
  },
  {
    value: "yearly",
    label: "Yearly",
    description: "Once a year, in the start date’s month.",
  },
];

const WEEKDAY_OPTIONS: PickerOption<string>[] = WEEKDAY_NAMES.map(
  (name, index) => ({ value: String(index + 1), label: name }),
);

const HEADING_OPTIONS: PickerOption<BillHeading>[] = BILL_HEADINGS.map(
  (heading) => ({ value: heading, label: HEADING_LABELS[heading] }),
);

const PAY_VIA_OPTIONS: PickerOption<RecurringPayVia>[] = [
  {
    value: "expendi",
    label: "Through Expendi",
    description: "You pay each bill from the wallet.",
  },
  {
    value: "outside",
    label: "Outside Expendi",
    description: "E.g. by card. You get the reminders and mark each bill paid.",
  },
];

type RecurringFormProps = {
  organizationId: string;
  initialDraft: RecurringDraft;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
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
 * The new and edit recurring payment form (spec §6.20). The payee,
 * schedule, start date and how it's paid are set once; changes apply to
 * bills still to come.
 */
export function RecurringForm(props: RecurringFormProps): JSX.Element {
  const { organizationId, initialDraft, submitLabel, submitting, submitError } =
    props;
  const [draft, setDraft] = useState<RecurringDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [payeeKind, setPayeeKind] = useState<PayeeKind | null>(
    props.item?.payee.kind ?? null,
  );
  const [payeeOutside, setPayeeOutside] = useState(false);

  function update<K extends keyof RecurringDraft>(
    field: K,
    value: RecurringDraft[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function submit(): void {
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
    <>
      <View className="gap-4">
        {props.item ? (
          <SetOnce item={props.item} />
        ) : (
          <>
            <PayeeField
              organizationId={organizationId}
              value={draft.payeeId}
              onChange={(payee) => {
                update("payeeId", payee.id);
                setPayeeKind(payee.kind);
                const currency = currencyOfPayee(payee.details?.method, "kes");
                if (currency !== draft.currency) {
                  setDraft((current) => ({ ...current, currency, amount: "" }));
                }
                const outside = payee.details?.method === "outside";
                setPayeeOutside(outside);
                if (outside) update("payVia", "outside");
              }}
            />
            <ErrorMessage message={fieldErrors.payeeId ?? null} />
          </>
        )}

        <OptionPicker
          label="Amount"
          options={AMOUNT_OPTIONS}
          value={draft.variable ? "variable" : "fixed"}
          onChange={(value) => update("variable", value === "variable")}
        />
        {draft.variable ? null : (
          <TextField
            label={`Amount (${CURRENCY_LABELS[draft.currency]})`}
            value={draft.amount}
            onChangeText={(value) => update("amount", value)}
            placeholder={draft.currency === "usd" ? "120.00" : "45,000.00"}
            keyboardType="decimal-pad"
          />
        )}
        {draft.currency === "usd" ? (
          <Text className="text-sm text-gray-600">
            This payee is paid in USDC: each bill pays exactly this many USDC.
          </Text>
        ) : null}
        <ErrorMessage message={fieldErrors.amount ?? null} />
        {props.item ? (
          <Text className="text-sm text-gray-600">
            A new amount applies from the next bill. To change the bill already
            created, edit that bill.
          </Text>
        ) : null}

        {props.item ? null : (
          <ScheduleFields
            draft={draft}
            errors={fieldErrors}
            onChange={(changes) =>
              setDraft((current) => ({ ...current, ...changes }))
            }
          />
        )}

        <TextField
          label="End date (YYYY-MM-DD, optional)"
          value={draft.endsOn}
          onChangeText={(value) => update("endsOn", value)}
          placeholder="Leave blank to keep going"
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          maxLength={10}
        />
        <ErrorMessage message={fieldErrors.endsOn ?? null} />

        {props.item ? null : (
          <>
            <OptionPicker
              label="How it’s paid"
              options={PAY_VIA_OPTIONS.map((option) => ({
                ...option,
                description:
                  option.value === "expendi" && payeeOutside
                    ? "Not for this payee: they’re paid outside Expendi."
                    : option.description,
              }))}
              value={draft.payVia}
              onChange={(payVia) => {
                if (payVia === "expendi" && payeeOutside) return;
                update("payVia", payVia);
              }}
            />
            <ErrorMessage message={fieldErrors.payVia ?? null} />
          </>
        )}

        <TextField
          label="Remind admins (days before it’s due)"
          value={draft.reminderDays}
          onChangeText={(value) => update("reminderDays", value)}
          placeholder="3"
          keyboardType="number-pad"
          maxLength={2}
        />
        <ErrorMessage message={fieldErrors.reminderDays ?? null} />
        <Text className="text-sm text-gray-600">
          Up to {REMINDER_DAYS_MAX} days. Admins are also reminded on the due
          date, and once if it’s overdue.
        </Text>

        <OptionPicker
          label="Overview heading"
          options={HEADING_OPTIONS}
          value={
            draft.heading ??
            (payeeKind ? defaultBillHeading(payeeKind) : "transactions")
          }
          onChange={(heading) => update("heading", heading)}
        />
        <ErrorMessage message={fieldErrors.heading ?? null} />

        <CategoryField
          organizationId={organizationId}
          current={props.item?.category}
          value={draft.categoryId}
          onChange={(categoryId) => update("categoryId", categoryId)}
        />
        <ErrorMessage message={fieldErrors.categoryId ?? null} />
      </View>

      <View className="gap-3">
        <ErrorMessage
          message={submitError ? describeApiError(submitError) : null}
        />
        <Button label={submitLabel} loading={submitting} onPress={submit} />
      </View>
    </>
  );
}

/** What can't change once the payment is set up. */
function SetOnce({ item }: { item: RecurringItem }): JSX.Element {
  return (
    <View className="gap-4">
      <ReviewRow label="Pay to" value={item.payee.name} />
      <ReviewRow label="When" value={scheduleInWords(item)} />
      <ReviewRow label="Starts" value={formatIsoDate(item.startsOn)} />
      <Text className="text-sm text-gray-600">
        To change who it’s paid to, when, or how, end this payment and set up a
        new one.
      </Text>
    </View>
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
    <>
      <OptionPicker
        label="How often"
        options={SCHEDULE_OPTIONS}
        value={draft.schedule}
        onChange={(schedule) =>
          onChange({
            schedule,
            scheduleDay: validStart
              ? defaultScheduleDay(schedule, draft.startsOn.trim())
              : "",
          })
        }
      />
      <ErrorMessage message={errors.schedule ?? null} />

      <TextField
        label="Start date (YYYY-MM-DD)"
        value={draft.startsOn}
        onChangeText={(startsOn) => onChange({ startsOn })}
        placeholder="2026-11-30"
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        maxLength={10}
      />
      <ErrorMessage message={errors.startsOn ?? null} />

      {draft.schedule === "weekly" ? (
        <OptionPicker
          label="Due every"
          options={WEEKDAY_OPTIONS}
          value={draft.scheduleDay}
          onChange={(scheduleDay) => onChange({ scheduleDay })}
        />
      ) : (
        <>
          <TextField
            label="Day of the month it’s due (1–31)"
            value={draft.scheduleDay}
            onChangeText={(scheduleDay) => onChange({ scheduleDay })}
            placeholder="28"
            keyboardType="number-pad"
            maxLength={2}
          />
          <Text className="text-sm text-gray-600">
            In a shorter month, it’s due on the month’s last day.
          </Text>
        </>
      )}
      <ErrorMessage message={errors.scheduleDay ?? null} />

      {validDay && validStart ? (
        <ReviewRow
          label="Due"
          value={describeSchedule(draft.schedule, day, draft.startsOn.trim())}
        />
      ) : null}
    </>
  );
}

function PayeeField({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: string | null;
  onChange: (payee: Pick<Payee, "id" | "kind" | "details">) => void;
}): JSX.Element {
  const payees = usePayees(organizationId, {
    kind: null,
    method: null,
    archived: false,
  });

  if (payees.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading payees" />;
  }
  if (payees.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(payees.error)} />
        <Button
          label="Load payees again"
          variant="secondary"
          onPress={() => void payees.refetch()}
        />
      </View>
    );
  }
  if (payees.data.length === 0) {
    return (
      <Text className="text-base text-gray-600">
        Add the payee first, then come back to set up the payment.
      </Text>
    );
  }
  return (
    <OptionPicker
      label="Pay to"
      options={payees.data.map((payee) => ({
        value: payee.id,
        label: payee.name,
        description:
          payee.details?.method === "outside"
            ? `${KIND_LABELS[payee.kind]} · Paid outside Expendi`
            : KIND_LABELS[payee.kind],
      }))}
      value={value ?? ""}
      onChange={(payeeId) => {
        const picked = payees.data.find((payee) => payee.id === payeeId);
        if (picked) onChange(picked);
      }}
    />
  );
}

function CategoryField({
  organizationId,
  current,
  value,
  onChange,
}: {
  organizationId: string;
  current: RecurringItem["category"] | undefined;
  value: string | null;
  onChange: (categoryId: string) => void;
}): JSX.Element {
  const categories = useCategories(organizationId);

  if (categories.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading categories" />;
  }
  if (categories.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(categories.error)} />
        <Button
          label="Load categories again"
          variant="secondary"
          onPress={() => void categories.refetch()}
        />
      </View>
    );
  }
  const choices =
    current && !categories.data.some((category) => category.id === current.id)
      ? [...categories.data, current]
      : categories.data;
  return (
    <OptionPicker
      label="Category"
      options={choices.map((category) => ({
        value: category.id,
        label: category.name,
      }))}
      value={value ?? ""}
      onChange={onChange}
    />
  );
}
