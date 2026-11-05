import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  CreateSalaryRequest,
  Salary,
  UpdateSalaryRequest,
} from "@expendi-business/shared";
import {
  createSalaryRequestSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import type { SalaryDraft } from "./payroll-display";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { ReviewRow } from "~/features/claims/claim-editor";
import { useCategories } from "~/features/claims/use-claims";
import { KIND_LABELS } from "~/features/payees/payee-display";
import { usePayees } from "~/features/payees/use-payees";
import { describeApiError } from "~/lib/api";
import {
  canBePaidSalary,
  DRAFT_TIMING,
  payDayInWords,
  salaryPayees,
  toCreateSalaryRequest,
  toUpdateSalaryRequest,
} from "./payroll-display";

type ErrorField = "payeeId" | "amount" | "payDay" | "startsOn" | "categoryId";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Readonly<Record<string, ErrorField>> = {
  payeeId: "payeeId",
  amountKes: "amount",
  payDay: "payDay",
  startsOn: "startsOn",
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

type SalaryFormProps = {
  organizationId: string;
  initialDraft: SalaryDraft;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
} & (
  | {
      /** Putting someone on payroll. */
      salary?: undefined;
      onSubmit: (request: CreateSalaryRequest) => void;
    }
  | {
      /** The pay day and category of a salary; net pay has its own step. */
      salary: Salary;
      onSubmit: (request: UpdateSalaryRequest) => void;
    }
);

/** The new salary form, and the pay day and category of an existing one (spec §6.21). */
export function SalaryForm(props: SalaryFormProps): JSX.Element {
  const { organizationId, initialDraft, submitLabel, submitting, submitError } =
    props;
  const [draft, setDraft] = useState<SalaryDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function update<K extends keyof SalaryDraft>(
    field: K,
    value: SalaryDraft[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function submit(): void {
    if (props.salary === undefined) {
      const request = toCreateSalaryRequest(draft);
      const parsed = createSalaryRequestSchema.safeParse(request);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsOf(parsed.error.issues));
        return;
      }
      setFieldErrors({});
      props.onSubmit(request);
      return;
    }
    const request = toUpdateSalaryRequest(props.salary, draft);
    const parsed = updateSalaryRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsOf(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    props.onSubmit(request);
  }

  const payDay = Number(draft.payDay);
  const validPayDay = Number.isInteger(payDay) && payDay >= 1 && payDay <= 31;

  return (
    <>
      <View className="gap-4">
        {props.salary ? null : (
          <>
            <PayeeField
              organizationId={organizationId}
              value={draft.payeeId}
              onChange={(payeeId) => update("payeeId", payeeId)}
            />
            <ErrorMessage message={fieldErrors.payeeId ?? null} />

            <TextField
              label="Monthly net pay (KES)"
              value={draft.amount}
              onChangeText={(value) => update("amount", value)}
              placeholder="45,000.00"
              keyboardType="decimal-pad"
            />
            <ErrorMessage message={fieldErrors.amount ?? null} />
            <Text className="text-sm text-gray-600">
              What lands in their account. Expendi doesn’t work out tax.
            </Text>
          </>
        )}

        <TextField
          label="Pay day (1–31)"
          value={draft.payDay}
          onChangeText={(value) => update("payDay", value)}
          placeholder="28"
          keyboardType="number-pad"
          maxLength={2}
        />
        <ErrorMessage message={fieldErrors.payDay ?? null} />
        {validPayDay ? (
          <ReviewRow label="Paid" value={payDayInWords(payDay)} />
        ) : null}
        {props.salary ? (
          <Text className="text-sm text-gray-600">
            A new pay day applies from the next pay date that isn’t drafted yet.
          </Text>
        ) : (
          <>
            <TextField
              label="Start date (YYYY-MM-DD)"
              value={draft.startsOn}
              onChangeText={(value) => update("startsOn", value)}
              placeholder="2026-12-01"
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={10}
            />
            <ErrorMessage message={fieldErrors.startsOn ?? null} />
            <Text className="text-sm text-gray-600">{DRAFT_TIMING}</Text>
          </>
        )}

        <CategoryField
          organizationId={organizationId}
          current={props.salary?.category}
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

/** Employees and other personnel only; pay goes to an M-Pesa number or a bank. */
function PayeeField({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: string | null;
  onChange: (payeeId: string) => void;
}): JSX.Element {
  const payees = usePayees(organizationId, {
    kind: null,
    method: null,
    archived: false,
  });

  if (payees.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading people" />;
  }
  if (payees.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(payees.error)} />
        <Button
          label="Load people again"
          variant="secondary"
          onPress={() => void payees.refetch()}
        />
      </View>
    );
  }
  const people = salaryPayees(payees.data);
  if (people.length === 0) {
    return (
      <Text className="text-base text-gray-600">
        Add the person as a payee first, as an employee or other personnel, then
        come back to set up their salary.
      </Text>
    );
  }
  return (
    <OptionPicker
      label="Who’s paid"
      options={people.map((payee) => ({
        value: payee.id,
        label: payee.name,
        description: canBePaidSalary(payee)
          ? KIND_LABELS[payee.kind]
          : `${KIND_LABELS[payee.kind]} · Add their M-Pesa number or bank account first`,
      }))}
      value={value ?? ""}
      onChange={onChange}
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
  current: Salary["category"] | undefined;
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
