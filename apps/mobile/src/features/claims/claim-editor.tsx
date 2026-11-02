import type { JSX, ReactNode } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Image, Text, View } from "react-native";

import type {
  Category,
  SubmitClaimFields,
  SubmitClaimRequest,
} from "@expendi-business/shared";
import {
  CLAIM_DESCRIPTION_MAX_LENGTH,
  ETIMS_INVOICE_NUMBER_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  submitClaimRequestSchema,
} from "@expendi-business/shared";

import type { ClaimDraft, DraftField, DraftState, FieldSource } from "./draft";
import type { AttachedSms } from "./sms-evidence";
import type { ReadingStatus } from "./use-receipt-reading";
import type { ReceiptSlot } from "./use-receipt-slots";
import type { PickerOption } from "~/components/option-picker";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { TextField } from "~/components/text-field";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { formatIsoDate } from "./dates";
import {
  applyChosenPrefill,
  applyReceiptPrefill,
  initialDraftState,
  readScannedQr,
  receiptPrefill,
  typeField,
} from "./draft";
import { duplicateOfError } from "./duplicates";
import { EtimsScanner } from "./etims-scanner";
import { ReceiptPicker } from "./receipt-picker";
import { SmsEvidence } from "./sms-evidence";
import { useCategories } from "./use-claims";
import { useReceiptReading } from "./use-receipt-reading";
import { useReceiptSlots } from "./use-receipt-slots";

type ErrorField = keyof ClaimDraft | "receipts";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Partial<Record<keyof SubmitClaimRequest, ErrorField>> = {
  receiptFileIds: "receipts",
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

const blankToNull = (value: string): string | null =>
  value.trim() === "" ? null : value;

/** Empty optional fields are sent as null, which clears them on an edit. */
function toClaimRequest(
  draft: ClaimDraft,
  receiptFileIds: string[],
): SubmitClaimRequest {
  return {
    receiptFileIds,
    merchant: draft.merchant,
    amountKes: draft.amount,
    spentOn: draft.spentOn.trim(),
    categoryId: draft.categoryId ?? "",
    description: draft.description,
    mpesaCode: blankToNull(draft.mpesaCode),
    etimsInvoiceNumber: blankToNull(draft.etimsInvoiceNumber),
    etimsSupplierPin: blankToNull(draft.etimsSupplierPin),
    etimsQrPayload: draft.etimsQrPayload,
  };
}

interface ClaimEditorProps {
  organizationId: string;
  initialDraft: ClaimDraft;
  initialReceipts?: ReceiptSlot[];
  initialSms?: AttachedSms | null;
  /** Fields that already hold the person's values, e.g. on an edit. */
  initialTyped?: readonly DraftField[];
  /** The claim's category now, which stays pickable even once it's archived. */
  currentCategory?: Pick<Category, "id" | "name">;
  /** Shown above the form, e.g. why the claim was rejected. */
  intro?: ReactNode;
  submitLabel: string;
  submitting: boolean;
  submitError: unknown;
  onSubmit: (request: SubmitClaimRequest) => void;
}

/**
 * The claim form, then a review of exactly what will be sent: the employee
 * always checks the fields before submitting (spec §6.3).
 */
export function ClaimEditor({
  organizationId,
  initialDraft,
  initialReceipts,
  initialSms = null,
  initialTyped = [],
  currentCategory,
  intro,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
}: ClaimEditorProps): JSX.Element {
  const [form, setForm] = useState<DraftState>(() =>
    initialDraftState(initialDraft, initialTyped),
  );
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
  const [review, setReview] = useState<{
    request: SubmitClaimRequest;
    fields: SubmitClaimFields;
  } | null>(null);
  const { draft, sources } = form;
  const receiptFileIds = sms
    ? [...receipts.receiptFileIds, sms.receiptFileId]
    : receipts.receiptFileIds;

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
    const request = toClaimRequest(draft, receiptFileIds);
    const parsed = submitClaimRequestSchema.safeParse(request);
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        const field =
          typeof key === "string"
            ? ERROR_FIELDS[key as keyof SubmitClaimRequest]
            : undefined;
        if (field && !errors[field]) errors[field] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setReview({ request, fields: parsed.data });
  }

  if (review) {
    const categoryName =
      categories?.find((category) => category.id === review.fields.categoryId)
        ?.name ?? "";
    return (
      <ClaimReview
        fields={review.fields}
        sources={sources}
        categoryName={categoryName}
        previews={receipts.slots.map((slot) => slot.previewUri)}
        smsText={sms?.text ?? null}
        submitLabel={submitLabel}
        submitting={submitting}
        submitError={submitError}
        onSubmit={() => onSubmit(review.request)}
        onBack={() => setReview(null)}
      />
    );
  }

  const failedUploads = receipts.slots.some((slot) => slot.status === "failed");

  return (
    <>
      {intro}
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

      <View className="gap-4">
        <TextField
          label="Paid to"
          value={draft.merchant}
          onChangeText={(value) => update("merchant", value)}
          placeholder="Shop, restaurant or person"
          autoCapitalize="words"
          maxLength={MERCHANT_MAX_LENGTH}
        />
        <SourceNote source={sources.merchant} />
        <ErrorMessage message={fieldErrors.merchant ?? null} />

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

        <CategoryField
          categories={categories}
          loading={categoryList.isPending}
          loadError={categoryList.isError ? categoryList.error : null}
          onRetry={() => void categoryList.refetch()}
          value={draft.categoryId}
          onChange={(value) => update("categoryId", value)}
        />
        <ErrorMessage message={fieldErrors.categoryId ?? null} />

        <TextField
          label="What was it for?"
          value={draft.description}
          onChangeText={(value) => update("description", value)}
          placeholder="Lunch with a client"
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

/** Reading a receipt only pre-fills the form; the person can stop waiting. */
function ReadingNotice({
  status,
  onStop,
}: {
  status: ReadingStatus;
  onStop: () => void;
}): JSX.Element | null {
  if (status === "reading") {
    return (
      <View className="gap-2 rounded-xl bg-gray-50 p-3">
        <View className="flex-row items-center gap-2">
          <ActivityIndicator accessibilityLabel="Reading the receipt" />
          <Text className="text-sm text-gray-700">
            Reading the receipt to fill in the details…
          </Text>
        </View>
        <Button label="Stop and type it in" variant="ghost" onPress={onStop} />
      </View>
    );
  }
  if (status === "unreadable") {
    return (
      <Text accessibilityLiveRegion="polite" className="text-sm text-gray-700">
        Couldn’t read this receipt, enter the details by hand.
      </Text>
    );
  }
  if (status === "read") {
    return (
      <Text accessibilityLiveRegion="polite" className="text-sm text-gray-700">
        Filled in from the receipt. Check each field before you submit.
      </Text>
    );
  }
  return null;
}

function CategoryField({
  categories,
  loading,
  loadError,
  onRetry,
  value,
  onChange,
}: {
  categories: Category[] | undefined;
  loading: boolean;
  loadError: unknown;
  onRetry: () => void;
  value: string | null;
  onChange: (value: string) => void;
}): JSX.Element {
  if (loading) {
    return <ActivityIndicator accessibilityLabel="Loading categories" />;
  }
  if (!categories) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(loadError)} />
        <Button
          label="Load categories again"
          variant="secondary"
          onPress={onRetry}
        />
      </View>
    );
  }
  const options: PickerOption<string>[] = categories.map((category) => ({
    value: category.id,
    label: category.name,
  }));
  return (
    <OptionPicker
      label="Category"
      options={options}
      value={value ?? ""}
      onChange={onChange}
    />
  );
}

function ClaimReview({
  fields,
  sources,
  categoryName,
  previews,
  smsText,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
  onBack,
}: {
  fields: SubmitClaimFields;
  sources: DraftState["sources"];
  categoryName: string;
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
  const onOpenClaim = (claimId: string) =>
    router.push({ pathname: "/claims/[claimId]", params: { claimId } });
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          Check your claim
        </Text>
        <Text className="text-base text-gray-600">
          Make sure these match the receipt before you send it.
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
        <ReviewRow
          label="Paid to"
          value={fields.merchant}
          source={sources.merchant}
        />
        <ReviewRow
          label="Amount"
          value={`KES ${formatKesCents(fields.amountKes.toString())}`}
          source={sources.amount}
        />
        <ReviewRow
          label="Date paid"
          value={formatIsoDate(fields.spentOn)}
          source={sources.spentOn}
        />
        <ReviewRow label="Category" value={categoryName} />
        <ReviewRow label="What it was for" value={fields.description} />
        {fields.mpesaCode ? (
          <ReviewRow
            label="M-Pesa code"
            value={fields.mpesaCode}
            source={sources.mpesaCode}
          />
        ) : null}
        {fields.etimsInvoiceNumber ? (
          <ReviewRow
            label="eTIMS invoice number"
            value={fields.etimsInvoiceNumber}
            source={sources.etimsInvoiceNumber}
          />
        ) : null}
        {fields.etimsSupplierPin ? (
          <ReviewRow
            label="Supplier’s KRA PIN"
            value={fields.etimsSupplierPin}
            source={sources.etimsSupplierPin}
          />
        ) : null}
        {fields.etimsQrPayload ? (
          <ReviewRow label="eTIMS QR code" value="Scanned" />
        ) : null}
      </View>

      <View className="gap-3">
        <ErrorMessage
          message={submitError ? describeApiError(submitError) : null}
        />
        {duplicate?.expenseId && duplicate.kind === "claim" ? (
          <Button
            label="Open the earlier claim"
            variant="secondary"
            onPress={() => {
              if (duplicate.expenseId) onOpenClaim(duplicate.expenseId);
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

export function ReviewRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: FieldSource | undefined;
}): JSX.Element {
  return (
    <View
      className={`gap-0.5 ${source === "receipt_unsure" ? "rounded-lg bg-amber-50 p-2" : ""}`}
    >
      <Text className="text-sm text-gray-500">{label}</Text>
      <Text className="text-base font-semibold text-gray-900">{value}</Text>
      <SourceNote source={source} />
    </View>
  );
}

const SOURCE_NOTES: Record<FieldSource, string> = {
  sms: "From the M-Pesa SMS",
  qr: "From the eTIMS QR code",
  receipt: "Read from receipt, check it",
  receipt_unsure: "Read from receipt but hard to make out, check it carefully",
};

/** Says where a value the person didn't type came from (spec §6.3). */
function SourceNote({
  source,
}: {
  source: FieldSource | undefined;
}): JSX.Element | null {
  if (!source) return null;
  return (
    <Text
      className={
        source === "receipt_unsure"
          ? "text-sm font-semibold text-amber-800"
          : "text-sm text-gray-500"
      }
    >
      {SOURCE_NOTES[source]}
    </Text>
  );
}

/** Scanning is optional; an unreadable code is still kept (spec §6.4). */
function EtimsQrField({
  scanned,
  note,
  error,
  onScan,
  onRemove,
}: {
  scanned: boolean;
  note: string | null;
  error: string | null;
  onScan: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <View className="gap-2">
      {scanned ? (
        <View className="flex-row items-center justify-between gap-3 rounded-xl border border-gray-200 p-3">
          <Text className="flex-1 text-sm text-gray-700">
            {note ?? "eTIMS QR scanned."}
          </Text>
          <Button label="Remove" variant="ghost" onPress={onRemove} />
        </View>
      ) : (
        <Button label="Scan eTIMS QR" variant="secondary" onPress={onScan} />
      )}
      <ErrorMessage message={error} />
    </View>
  );
}
