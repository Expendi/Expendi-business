import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  Bill,
  BillHeading,
  CreateBillRequest,
  Payee,
  PayeeKind,
  PayeeMethod,
  UpdateBillRequest,
} from "@expendi-business/shared";
import {
  BILL_HEADINGS,
  BILL_NOTES_MAX_LENGTH,
  BILL_REASON_MAX_LENGTH,
  BILL_REFERENCE_MAX_LENGTH,
  createBillRequestSchema,
  defaultBillHeading,
  updateBillRequestSchema,
} from "@expendi-business/shared";

import type { BillDraft } from "./bill-draft";
import type { PickerOption } from "~/components/option-picker";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { ReceiptPicker } from "~/features/claims/receipt-picker";
import { useCategories } from "~/features/claims/use-claims";
import { useReceiptSlots } from "~/features/claims/use-receipt-slots";
import { KIND_LABELS } from "~/features/payees/payee-display";
import { usePayees } from "~/features/payees/use-payees";
import { useCompanyWallet } from "~/features/wallet/use-company-wallet";
import { describeApiError } from "~/lib/api";
import { CURRENCY_LABELS, currencyOfPayee } from "./bill-amount";
import { amountChanged, toCreateRequest, toUpdateRequest } from "./bill-draft";
import { HEADING_LABELS } from "./bill-status";
import {
  amountRefusal,
  cashOutAmountError,
  cashOutAmountHint,
  cashOutLimitsOf,
} from "./cash-out-amount";

type ErrorField =
  | "payeeId"
  | "amount"
  | "dueOn"
  | "heading"
  | "categoryId"
  | "reference"
  | "notes"
  | "adjustmentReason"
  | "invoices";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Readonly<Record<string, ErrorField>> = {
  payeeId: "payeeId",
  amountKes: "amount",
  amountUsd: "amount",
  dueOn: "dueOn",
  overviewHeading: "heading",
  categoryId: "categoryId",
  reference: "reference",
  notes: "notes",
  adjustmentReason: "adjustmentReason",
  invoiceFileIds: "invoices",
};

const HEADING_OPTIONS: PickerOption<BillHeading>[] = BILL_HEADINGS.map(
  (heading) => ({ value: heading, label: HEADING_LABELS[heading] }),
);

const AMOUNT_OPTIONS: PickerOption<"fixed" | "variable">[] = [
  { value: "fixed", label: "Fixed amount" },
  {
    value: "variable",
    label: "Variable",
    description: "Entered each time, e.g. PAYE or electricity.",
  },
];

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

type BillFormProps = {
  organizationId: string;
  initialDraft: BillDraft;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
} & (
  | {
      /** A new bill; invoices are uploaded with it. */
      bill?: undefined;
      onSubmit: (request: CreateBillRequest) => void;
    }
  | {
      /** The bill being changed; only what changed is sent. */
      bill: Bill;
      onSubmit: (request: UpdateBillRequest) => void;
    }
);

/** The new-bill and edit-bill form (spec §6.20). */
export function BillForm(props: BillFormProps): JSX.Element {
  const { organizationId, initialDraft, submitLabel, submitting, submitError } =
    props;
  const invoices = useReceiptSlots(organizationId);
  const [draft, setDraft] = useState<BillDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [payeeKind, setPayeeKind] = useState<PayeeKind | null>(
    props.bill?.payee.kind ?? null,
  );
  const [payeeMethod, setPayeeMethod] = useState<PayeeMethod | null>(
    props.bill?.payee.method ?? null,
  );
  const wallet = useCompanyWallet(organizationId);
  const limits = cashOutLimitsOf(wallet.data);
  const typedAmount = { ...draft, method: payeeMethod };

  function update<K extends keyof BillDraft>(field: K, value: BillDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  const editing = props.bill !== undefined;
  const needsReason =
    props.bill !== undefined &&
    !props.bill.variable &&
    amountChanged(props.bill, draft);

  /** Schema errors first; then, as the API would, the cash-out limits. */
  function errorsOf(
    issues: Parameters<typeof fieldErrorsOf>[0] | undefined,
    amountSent: boolean,
  ): FieldErrors {
    const errors = issues ? fieldErrorsOf(issues) : {};
    const problem = amountSent ? cashOutAmountError(typedAmount, limits) : null;
    if (problem !== null && errors.amount === undefined) {
      errors.amount = problem;
    }
    return errors;
  }

  function submit(): void {
    if (props.bill === undefined) {
      const request = toCreateRequest(draft, invoices.receiptFileIds);
      const parsed = createBillRequestSchema.safeParse(request);
      const errors = errorsOf(parsed.error?.issues, true);
      setFieldErrors(errors);
      if (Object.keys(errors).length === 0) props.onSubmit(request);
      return;
    }
    const request = toUpdateRequest(props.bill, draft);
    const parsed = updateBillRequestSchema.safeParse(request);
    const errors = errorsOf(
      parsed.error?.issues,
      request.amountKes !== undefined || request.payeeId !== undefined,
    );
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) props.onSubmit(request);
  }

  const refusedAmount = amountRefusal(submitError);
  const amountHint = cashOutAmountHint(typedAmount, limits);

  const failedUploads = invoices.slots.some((slot) => slot.status === "failed");

  return (
    <>
      <View className="gap-4">
        <PayeeField
          organizationId={organizationId}
          current={props.bill?.payee}
          value={draft.payeeId}
          onChange={(payeeId) => update("payeeId", payeeId)}
          onPicked={(payee) => {
            setPayeeKind(payee.kind);
            setPayeeMethod(payee.method);
            const currency = currencyOfPayee(payee.method, "kes");
            if (currency !== draft.currency) {
              setDraft((current) => ({ ...current, currency, amount: "" }));
            }
          }}
        />
        <ErrorMessage message={fieldErrors.payeeId ?? null} />

        {editing ? null : (
          <OptionPicker
            label="Amount"
            options={AMOUNT_OPTIONS}
            value={draft.variable ? "variable" : "fixed"}
            onChange={(value) => update("variable", value === "variable")}
          />
        )}
        <TextField
          label={
            draft.variable
              ? `Amount (${CURRENCY_LABELS[draft.currency]}, if you know it)`
              : `Amount (${CURRENCY_LABELS[draft.currency]})`
          }
          value={draft.amount}
          onChangeText={(value) => update("amount", value)}
          placeholder={draft.currency === "usd" ? "120.00" : "15,000.00"}
          keyboardType="decimal-pad"
        />
        {draft.currency === "usd" ? (
          <Text className="text-sm text-gray-600">
            This payee is paid in USDC: they receive exactly this many USDC.
          </Text>
        ) : null}
        {amountHint ? (
          <Text className="text-sm text-gray-600">{amountHint}</Text>
        ) : null}
        <ErrorMessage message={fieldErrors.amount ?? refusedAmount} />

        {needsReason ? (
          <>
            <TextField
              label="Why did the amount change?"
              value={draft.adjustmentReason}
              onChangeText={(value) => update("adjustmentReason", value)}
              placeholder="Late fee added"
              maxLength={BILL_REASON_MAX_LENGTH}
            />
            <ErrorMessage message={fieldErrors.adjustmentReason ?? null} />
          </>
        ) : null}

        <TextField
          label="Due date (YYYY-MM-DD)"
          value={draft.dueOn}
          onChangeText={(value) => update("dueOn", value)}
          placeholder="2026-11-30"
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          maxLength={10}
        />
        <ErrorMessage message={fieldErrors.dueOn ?? null} />

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
          current={props.bill?.category}
          value={draft.categoryId}
          onChange={(categoryId) => update("categoryId", categoryId)}
        />
        <ErrorMessage message={fieldErrors.categoryId ?? null} />

        <TextField
          label="Reference (optional)"
          value={draft.reference}
          onChangeText={(value) => update("reference", value)}
          placeholder="Invoice or KRA payment number"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={BILL_REFERENCE_MAX_LENGTH}
        />
        <ErrorMessage message={fieldErrors.reference ?? null} />

        <TextField
          label="Notes (optional)"
          value={draft.notes}
          onChangeText={(value) => update("notes", value)}
          multiline
          maxLength={BILL_NOTES_MAX_LENGTH}
        />
        <ErrorMessage message={fieldErrors.notes ?? null} />
      </View>

      {editing ? null : (
        <ReceiptPicker
          receipts={invoices}
          label="Invoice (optional)"
          error={fieldErrors.invoices ?? null}
        />
      )}

      <View className="gap-3">
        {failedUploads ? (
          <ErrorMessage message="Retry or remove the invoice that didn’t upload." />
        ) : null}
        <ErrorMessage
          message={
            submitError && refusedAmount === null
              ? describeApiError(submitError)
              : null
          }
        />
        <Button
          label={invoices.uploading ? "Uploading invoice…" : submitLabel}
          loading={submitting}
          disabled={invoices.uploading || failedUploads}
          onPress={submit}
        />
      </View>
    </>
  );
}

function PayeeField({
  organizationId,
  current,
  value,
  onChange,
  onPicked,
}: {
  organizationId: string;
  current: Bill["payee"] | undefined;
  value: string | null;
  onChange: (payeeId: string) => void;
  onPicked: (payee: {
    readonly kind: PayeeKind;
    readonly method: PayeeMethod | null;
  }) => void;
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
  const choices: Pick<Payee, "id" | "name" | "kind" | "details">[] =
    current && !payees.data.some((payee) => payee.id === current.id)
      ? [...payees.data, { ...current, details: null }]
      : payees.data;
  if (choices.length === 0) {
    return (
      <Text className="text-base text-gray-600">
        Add the payee first, then come back to add their bill.
      </Text>
    );
  }
  const options: PickerOption<string>[] = choices.map((payee) => ({
    value: payee.id,
    label: payee.name,
    description:
      payee.details?.method === "outside"
        ? `${KIND_LABELS[payee.kind]} · Paid outside Expendi`
        : KIND_LABELS[payee.kind],
  }));
  return (
    <OptionPicker
      label="Pay to"
      options={options}
      value={value ?? ""}
      onChange={(payeeId) => {
        onChange(payeeId);
        const picked = choices.find((payee) => payee.id === payeeId);
        if (picked) {
          onPicked({
            kind: picked.kind,
            method:
              picked.details?.method ??
              (current?.id === picked.id ? current.method : null),
          });
        }
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
  current: Bill["category"] | undefined;
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
