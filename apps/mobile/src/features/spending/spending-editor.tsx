import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Switch, Text, View } from "react-native";

import type {
  Category,
  CompanySpendingDetail,
  OverviewHeading,
  RecordCompanySpendingRequest,
  UpdateCompanySpendingRequest,
} from "@expendi-business/shared";
import {
  CLAIM_DESCRIPTION_MAX_LENGTH,
  ETIMS_INVOICE_NUMBER_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  NO_RECEIPT_REASON_MAX_LENGTH,
  parseKesToCents,
  recordCompanySpendingRequestSchema,
  updateCompanySpendingRequestSchema,
} from "@expendi-business/shared";

import type { ClaimDraft, DraftField, DraftState } from "../claims/draft";
import type { AttachedSms } from "../claims/sms-evidence";
import type { ReceiptSlot } from "../claims/use-receipt-slots";
import type { SpendingExtras } from "./spending-draft";
import type { ChipOption } from "~/features/payees/filter-chips";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { TextField } from "~/components/text-field";
import {
  CategoryField,
  EtimsQrField,
  ReadingNotice,
  ReviewRow,
  SourceNote,
} from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import {
  applyChosenPrefill,
  applyReceiptPrefill,
  initialDraftState,
  readScannedQr,
  receiptPrefill,
  typeField,
} from "~/features/claims/draft";
import { duplicateOfError } from "~/features/claims/duplicates";
import { EtimsScanner } from "~/features/claims/etims-scanner";
import { ReceiptPicker } from "~/features/claims/receipt-picker";
import { SmsEvidence } from "~/features/claims/sms-evidence";
import { useCategories } from "~/features/claims/use-claims";
import { useReceiptReading } from "~/features/claims/use-receipt-reading";
import { useReceiptSlots } from "~/features/claims/use-receipt-slots";
import { FilterChips } from "~/features/payees/filter-chips";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { PaidFromAccountPicker } from "./paid-from-account-picker";
import {
  HEADING_LABELS,
  receiptProblem,
  SPENDING_HEADINGS,
  toRecordRequest,
  toUpdateRequest,
} from "./spending-draft";
import { usePaidFromAccounts } from "./use-spending";

type ErrorField =
  keyof ClaimDraft | "receipts" | "noReceiptReason" | "paidFromAccountId";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Readonly<Record<string, ErrorField>> = {
  receiptFileIds: "receipts",
  noReceiptReason: "noReceiptReason",
  paidFromAccountId: "paidFromAccountId",
  merchant: "merchant",
  amountKes: "amount",
  spentOn: "spentOn",
  categoryId: "categoryId",
  description: "description",
  mpesaCode: "mpesaCode",
  etimsInvoiceNumber: "etimsInvoiceNumber",
  etimsSupplierPin: "etimsSupplierPin",
  etimsQrPayload: "etimsQrPayload",
};

const HEADING_OPTIONS: ChipOption<OverviewHeading>[] = SPENDING_HEADINGS.map(
  (heading) => ({ value: heading, label: HEADING_LABELS[heading] }),
);

export type SpendingEditorMode =
  | {
      kind: "record";
      onSubmit: (request: RecordCompanySpendingRequest) => void;
    }
  | {
      kind: "edit";
      spending: CompanySpendingDetail;
      onSubmit: (request: UpdateCompanySpendingRequest) => void;
    };

interface SpendingEditorProps {
  organizationId: string;
  mode: SpendingEditorMode;
  initialDraft: ClaimDraft;
  initialExtras: SpendingExtras;
  initialReceipts?: ReceiptSlot[];
  initialSms?: AttachedSms | null;
  initialTyped?: readonly DraftField[];
  currentCategory?: Pick<Category, "id" | "name">;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
}

type Prepared =
  | { kind: "record"; request: RecordCompanySpendingRequest }
  | { kind: "edit"; request: UpdateCompanySpendingRequest };

function issuesToErrors(
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

/**
 * The claim capture flow for spending the company already paid outside
 * Expendi (spec §6.23): receipt photo, pasted M-Pesa SMS, eTIMS QR and
 * receipt reading, plus the heading, the account it was paid from, and
 * "Save without receipt" with a reason. The admin reviews it before saving.
 */
export function SpendingEditor({
  organizationId,
  mode,
  initialDraft,
  initialExtras,
  initialReceipts,
  initialSms = null,
  initialTyped = [],
  currentCategory,
  submitLabel,
  submitting,
  submitError,
}: SpendingEditorProps): JSX.Element {
  const spending = mode.kind === "edit" ? mode.spending : null;
  const fromBill = spending?.bill ?? null;
  const billFileCount =
    spending?.receipts.filter((receipt) => receipt.billRole !== null).length ??
    0;
  const [form, setForm] = useState<DraftState>(() =>
    initialDraftState(initialDraft, initialTyped),
  );
  const [extras, setExtras] = useState<SpendingExtras>(initialExtras);
  const reading = useReceiptReading(organizationId);
  const receipts = useReceiptSlots(
    organizationId,
    initialReceipts,
    (receiptFileId) =>
      reading.read(receiptFileId, (result) =>
        setForm((current) =>
          applyReceiptPrefill(current, receiptPrefill(result)),
        ),
      ),
  );
  const categoryList = useCategories(organizationId);
  const accountList = usePaidFromAccounts(organizationId);
  const categories =
    categoryList.data &&
    currentCategory &&
    !categoryList.data.some((category) => category.id === currentCategory.id)
      ? [...categoryList.data, { ...currentCategory, etimsNotRequired: false }]
      : categoryList.data;
  const [sms, setSms] = useState<AttachedSms | null>(initialSms);
  const [scanning, setScanning] = useState(false);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [review, setReview] = useState<Prepared | null>(null);
  const { draft, sources } = form;
  const receiptFileIds = sms
    ? [...receipts.receiptFileIds, sms.receiptFileId]
    : receipts.receiptFileIds;
  const receiptCount = receiptFileIds.length + billFileCount;
  const accountName =
    extras.paidFromAccountId === null
      ? "Not specified"
      : (accountList.data?.find(
          (account) => account.id === extras.paidFromAccountId,
        )?.name ??
        spending?.paidFromAccount?.name ??
        "");
  const hasUploads = receipts.slots.length > 0 || sms !== null;

  function update<K extends keyof ClaimDraft>(
    field: K,
    value: ClaimDraft[K],
  ): void {
    setForm((current) => typeField(current, field, value));
  }

  function takeScannedQr(payload: string): void {
    const scanned = readScannedQr(payload);
    setForm((current) =>
      applyChosenPrefill(
        typeField(current, "etimsQrPayload", scanned.payload),
        scanned.prefill,
        "qr",
      ),
    );
    setQrNote(scanned.note);
    setScanning(false);
  }

  function goToReview(): void {
    const missingReceipt = receiptProblem(receiptCount, extras, {
      fromBill: fromBill !== null,
    });
    const prepared: Prepared = spending
      ? {
          kind: "edit",
          request: toUpdateRequest(spending, draft, extras, receiptFileIds),
        }
      : {
          kind: "record",
          request: toRecordRequest(draft, extras, receiptFileIds),
        };
    const parsed =
      prepared.kind === "edit"
        ? updateCompanySpendingRequestSchema.safeParse(prepared.request)
        : recordCompanySpendingRequestSchema.safeParse(prepared.request);
    const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (missingReceipt && !errors.receipts) errors.receipts = missingReceipt;
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setReview(prepared);
  }

  function submit(prepared: Prepared): void {
    if (prepared.kind === "edit" && mode.kind === "edit") {
      mode.onSubmit(prepared.request);
    }
    if (prepared.kind === "record" && mode.kind === "record") {
      mode.onSubmit(prepared.request);
    }
  }

  if (review) {
    const amountCents =
      fromBill && spending
        ? spending.amountKes
        : (parseKesToCents(draft.amount)?.toString() ?? "0");
    return (
      <SpendingReview
        rows={[
          { label: "Paid to", value: draft.merchant.trim() },
          { label: "Amount", value: `KES ${formatKesCents(amountCents)}` },
          { label: "Date paid", value: formatIsoDate(draft.spentOn.trim()) },
          {
            label: "Category",
            value:
              categories?.find((category) => category.id === draft.categoryId)
                ?.name ?? "",
          },
          { label: "Overview heading", value: HEADING_LABELS[extras.heading] },
          { label: "Paid from", value: accountName },
          { label: "What it was for", value: draft.description.trim() },
          ...(draft.mpesaCode.trim()
            ? [{ label: "M-Pesa code", value: draft.mpesaCode.trim() }]
            : []),
          ...(draft.etimsInvoiceNumber.trim()
            ? [
                {
                  label: "eTIMS invoice number",
                  value: draft.etimsInvoiceNumber.trim(),
                },
              ]
            : []),
          ...(receiptCount === 0 && extras.withoutReceipt
            ? [
                {
                  label: "Saved without a receipt because",
                  value: extras.noReceiptReason.trim(),
                },
              ]
            : []),
        ]}
        previews={receipts.slots.map((slot) => slot.previewUri)}
        smsText={sms?.text ?? null}
        submitLabel={submitLabel}
        submitting={submitting}
        submitError={submitError}
        onSubmit={() => submit(review)}
        onBack={() => setReview(null)}
      />
    );
  }

  const failedUploads = receipts.slots.some((slot) => slot.status === "failed");

  return (
    <>
      {fromBill ? (
        <Text className="text-base text-gray-600">
          Recorded when the bill from {fromBill.payee.name} was marked paid. Its
          amount and date stay the bill’s.
        </Text>
      ) : null}
      <ReceiptPicker receipts={receipts} error={fieldErrors.receipts} />
      <ReadingNotice status={reading.status} onStop={reading.stop} />
      <SmsEvidence
        organizationId={organizationId}
        attached={sms}
        onAttach={(attached, prefill) => {
          setSms(attached);
          setForm((current) => applyChosenPrefill(current, prefill));
        }}
        onRemove={() => setSms(null)}
      />
      {hasUploads || billFileCount > 0 ? null : (
        <WithoutReceipt
          extras={extras}
          error={fieldErrors.noReceiptReason ?? null}
          onChange={(changes) =>
            setExtras((current) => ({ ...current, ...changes }))
          }
        />
      )}

      <View className="gap-4">
        <TextField
          label="Paid to"
          value={draft.merchant}
          onChangeText={(value) => update("merchant", value)}
          placeholder="Supplier, shop or person"
          autoCapitalize="words"
          maxLength={MERCHANT_MAX_LENGTH}
        />
        <SourceNote source={sources.merchant} />
        <ErrorMessage message={fieldErrors.merchant ?? null} />

        {fromBill && spending ? (
          <>
            <ReviewRow
              label="Amount"
              value={`KES ${formatKesCents(spending.amountKes)}`}
            />
            <ReviewRow
              label="Date paid"
              value={formatIsoDate(spending.spentOn)}
            />
          </>
        ) : (
          <>
            <TextField
              label="Amount (KES)"
              value={draft.amount}
              onChangeText={(value) => update("amount", value)}
              placeholder="1,500.00"
              keyboardType="decimal-pad"
            />
            <SourceNote source={sources.amount} />
            <ErrorMessage message={fieldErrors.amount ?? null} />

            <TextField
              label="Date paid (YYYY-MM-DD)"
              value={draft.spentOn}
              onChangeText={(value) => update("spentOn", value)}
              placeholder="2026-11-02"
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={10}
            />
            <SourceNote source={sources.spentOn} />
            <ErrorMessage message={fieldErrors.spentOn ?? null} />
          </>
        )}

        <PaidFromAccountPicker
          organizationId={organizationId}
          value={extras.paidFromAccountId}
          onChange={(paidFromAccountId) =>
            setExtras((current) => ({ ...current, paidFromAccountId }))
          }
          current={spending?.paidFromAccount ?? null}
          error={fieldErrors.paidFromAccountId ?? null}
        />

        <CategoryField
          categories={categories}
          loading={categoryList.isPending}
          loadError={categoryList.isError ? categoryList.error : null}
          onRetry={() => void categoryList.refetch()}
          value={draft.categoryId}
          onChange={(value) => update("categoryId", value)}
        />
        <ErrorMessage message={fieldErrors.categoryId ?? null} />

        <FilterChips
          label="Overview heading"
          options={HEADING_OPTIONS}
          value={extras.heading}
          onChange={(heading) =>
            setExtras((current) => ({ ...current, heading }))
          }
        />

        <TextField
          label="What was it for?"
          value={draft.description}
          onChangeText={(value) => update("description", value)}
          placeholder="October electricity"
          multiline
          maxLength={CLAIM_DESCRIPTION_MAX_LENGTH}
        />
        <ErrorMessage message={fieldErrors.description ?? null} />

        <TextField
          label="M-Pesa code (optional)"
          value={draft.mpesaCode}
          onChangeText={(value) => update("mpesaCode", value)}
          placeholder="SLK4H7Q2XY"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
        />
        <SourceNote source={sources.mpesaCode} />
        <ErrorMessage message={fieldErrors.mpesaCode ?? null} />

        <EtimsQrField
          scanned={draft.etimsQrPayload !== null}
          note={qrNote}
          error={fieldErrors.etimsQrPayload ?? null}
          onScan={() => setScanning(true)}
          onRemove={() => {
            update("etimsQrPayload", null);
            setQrNote(null);
          }}
        />
        <EtimsScanner
          visible={scanning}
          onScanned={takeScannedQr}
          onClose={() => setScanning(false)}
        />

        <TextField
          label="eTIMS invoice number (optional)"
          value={draft.etimsInvoiceNumber}
          onChangeText={(value) => update("etimsInvoiceNumber", value)}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={ETIMS_INVOICE_NUMBER_MAX_LENGTH}
        />
        <SourceNote source={sources.etimsInvoiceNumber} />
        <ErrorMessage message={fieldErrors.etimsInvoiceNumber ?? null} />

        <TextField
          label="Supplier’s KRA PIN (optional)"
          value={draft.etimsSupplierPin}
          onChangeText={(value) => update("etimsSupplierPin", value)}
          placeholder="P051234567X"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={11}
        />
        <SourceNote source={sources.etimsSupplierPin} />
        <ErrorMessage message={fieldErrors.etimsSupplierPin ?? null} />
      </View>

      <View className="gap-3">
        {failedUploads ? (
          <ErrorMessage message="Retry or remove the receipt that didn’t upload." />
        ) : null}
        <Button
          label={
            receipts.uploading
              ? "Uploading receipt…"
              : reading.status === "reading"
                ? "Reading receipt…"
                : "Review"
          }
          disabled={
            receipts.uploading || failedUploads || reading.status === "reading"
          }
          onPress={goToReview}
        />
      </View>
    </>
  );
}

/** spec §6.23: an admin can save without a receipt by saying why. */
function WithoutReceipt({
  extras,
  error,
  onChange,
}: {
  extras: SpendingExtras;
  error: string | null;
  onChange: (changes: Partial<SpendingExtras>) => void;
}): JSX.Element {
  return (
    <View className="gap-3">
      <View className="min-h-14 flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-base text-gray-900">
          Save without receipt
        </Text>
        <Switch
          accessibilityLabel="Save without receipt"
          value={extras.withoutReceipt}
          onValueChange={(withoutReceipt) => onChange({ withoutReceipt })}
        />
      </View>
      {extras.withoutReceipt ? (
        <>
          <TextField
            label="Why is there no receipt?"
            value={extras.noReceiptReason}
            onChangeText={(noReceiptReason) => onChange({ noReceiptReason })}
            placeholder="Bank charge, no receipt issued"
            multiline
            maxLength={NO_RECEIPT_REASON_MAX_LENGTH}
          />
          <Text className="text-sm text-gray-600">
            It’s flagged “no receipt” until one is added.
          </Text>
        </>
      ) : null}
      <ErrorMessage message={error} />
    </View>
  );
}

function SpendingReview({
  rows,
  previews,
  smsText,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
  onBack,
}: {
  rows: { label: string; value: string }[];
  previews: string[];
  smsText: string | null;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
  onSubmit: () => void;
  onBack: () => void;
}): JSX.Element {
  const router = useRouter();
  const duplicate = duplicateOfError(submitError);
  const openEarlier = (
    expenseId: string,
    kind: "claim" | "float" | "company",
  ) =>
    kind === "company"
      ? router.push({
          pathname: "/spending/[spendingId]",
          params: { spendingId: expenseId },
        })
      : router.push({
          pathname: "/claims/[claimId]",
          params: { claimId: expenseId },
        });
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          Check the spending
        </Text>
        <Text className="text-base text-gray-600">
          Make sure these match the receipt before you save it.
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-3">
        {previews.map((uri) => (
          <Image
            key={uri}
            source={{ uri }}
            accessibilityLabel="Receipt"
            accessibilityIgnoresInvertColors
            className="h-40 w-32 rounded-lg bg-gray-100"
            resizeMode="cover"
          />
        ))}
      </View>
      {smsText ? (
        <View className="gap-1 rounded-xl border border-gray-200 p-3">
          <Text className="text-sm font-medium text-gray-700">M-Pesa SMS</Text>
          <Text className="text-sm text-gray-600" numberOfLines={4}>
            {smsText}
          </Text>
        </View>
      ) : null}

      <View className="gap-4">
        {rows.map((row) => (
          <ReviewRow key={row.label} label={row.label} value={row.value} />
        ))}
      </View>

      <View className="gap-3">
        <ErrorMessage
          message={submitError ? describeApiError(submitError) : null}
        />
        {duplicate?.expenseId && duplicate.kind !== "float" ? (
          <Button
            label="Open the earlier record"
            variant="secondary"
            onPress={() => {
              if (duplicate.expenseId) {
                openEarlier(duplicate.expenseId, duplicate.kind);
              }
            }}
          />
        ) : null}
        <Button label={submitLabel} loading={submitting} onPress={onSubmit} />
        <Button
          label="Back to edit"
          variant="ghost"
          disabled={submitting}
          onPress={onBack}
        />
      </View>
    </>
  );
}
