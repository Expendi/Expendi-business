import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Switch, View } from "react-native";

import type {
  FloatSummary,
  RecordFloatSpendingRequest,
} from "@expendi-business/shared";
import {
  CLAIM_DESCRIPTION_MAX_LENGTH,
  ETIMS_INVOICE_NUMBER_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  NO_RECEIPT_REASON_MAX_LENGTH,
  parseKesToCents,
  recordFloatSpendingRequestSchema,
} from "@expendi-business/shared";

import type { ClaimDraft, DraftState } from "../claims/draft";
import type { AttachedSms } from "../claims/sms-evidence";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
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
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { kes, overspendNotice } from "./float-display";

type ErrorField = keyof ClaimDraft | "receipts" | "noReceiptReason";
type FieldErrors = Partial<Record<ErrorField, string>>;

const ERROR_FIELDS: Readonly<Record<string, ErrorField>> = {
  receiptFileIds: "receipts",
  noReceiptReason: "noReceiptReason",
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

export function blankFloatSpendingDraft(today: string): ClaimDraft {
  return {
    merchant: "",
    amount: "",
    spentOn: today,
    categoryId: null,
    description: "",
    mpesaCode: "",
    etimsInvoiceNumber: "",
    etimsSupplierPin: "",
    etimsQrPayload: null,
  };
}

function toRequest(
  draft: ClaimDraft,
  receiptFileIds: string[],
  withoutReceipt: { on: boolean; reason: string },
): RecordFloatSpendingRequest {
  return {
    receiptFileIds,
    noReceiptReason:
      receiptFileIds.length === 0 && withoutReceipt.on
        ? withoutReceipt.reason
        : null,
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
 * "Paid from petty cash" (spec §6.22): the claim capture flow (receipt
 * photo, pasted M-Pesa SMS, eTIMS QR, receipt reading) for a purchase paid
 * from the holder's float. Anything over what's left is shown before
 * saving: it becomes a claim for an admin to approve, and needs a receipt.
 */
export function FloatSpendingEditor({
  organizationId,
  float,
  initialDraft,
  submitting,
  submitError,
  onSubmit,
}: {
  organizationId: string;
  float: FloatSummary;
  initialDraft: ClaimDraft;
  submitting: boolean;
  submitError: unknown;
  onSubmit: (request: RecordFloatSpendingRequest) => void;
}): JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<DraftState>(() =>
    initialDraftState(initialDraft),
  );
  const reading = useReceiptReading(organizationId);
  const receipts = useReceiptSlots(organizationId, undefined, (receiptFileId) =>
    reading.read(receiptFileId, (result) =>
      setForm((current) =>
        applyReceiptPrefill(current, receiptPrefill(result)),
      ),
    ),
  );
  const categoryList = useCategories(organizationId);
  const [sms, setSms] = useState<AttachedSms | null>(null);
  const [scanning, setScanning] = useState(false);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [withoutReceipt, setWithoutReceipt] = useState({
    on: false,
    reason: "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [review, setReview] = useState<RecordFloatSpendingRequest | null>(null);
  const { draft, sources } = form;
  const receiptFileIds = sms
    ? [...receipts.receiptFileIds, sms.receiptFileId]
    : receipts.receiptFileIds;
  const hasEvidence = receipts.slots.length > 0 || sms !== null;
  const overspend = overspendNotice(draft.amount, float.leftKes);
  const failedUploads = receipts.slots.some((slot) => slot.status === "failed");

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
    const request = toRequest(draft, receiptFileIds, withoutReceipt);
    const parsed = recordFloatSpendingRequestSchema.safeParse(request);
    const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (receiptFileIds.length === 0 && !errors.receipts) {
      if (overspend) {
        errors.receipts =
          "The extra becomes a claim, and a claim needs a receipt. Add a photo or screenshot, or paste the M-Pesa SMS.";
      } else if (!withoutReceipt.on) {
        errors.receipts = "Add a receipt, or choose No receipt and say why.";
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setReview(request);
  }

  if (review) {
    const duplicate = duplicateOfError(submitError);
    const amount = parseKesToCents(draft.amount)?.toString() ?? "0";
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
        {overspend ? <OverspendNotice text={overspend} /> : null}
        <View className="flex-row flex-wrap gap-3">
          {receipts.slots.map((slot) => (
            <Image
              key={slot.previewUri}
              source={{ uri: slot.previewUri }}
              accessibilityLabel="Receipt"
              accessibilityIgnoresInvertColors
              className="h-40 w-32 rounded-lg bg-gray-100"
              resizeMode="cover"
            />
          ))}
        </View>
        {sms ? (
          <View className="gap-1 rounded-xl border border-gray-200 p-3">
            <Text className="text-sm font-medium text-gray-700">
              M-Pesa SMS
            </Text>
            <Text className="text-sm text-gray-600" numberOfLines={4}>
              {sms.text}
            </Text>
          </View>
        ) : null}
        <View className="gap-4">
          <ReviewRow label="Paid to" value={draft.merchant.trim()} />
          <ReviewRow label="Amount" value={`KES ${formatKesCents(amount)}`} />
          <ReviewRow
            label="Date paid"
            value={formatIsoDate(draft.spentOn.trim())}
          />
          <ReviewRow
            label="Category"
            value={
              categoryList.data?.find(
                (category) => category.id === draft.categoryId,
              )?.name ?? ""
            }
          />
          <ReviewRow label="What it was for" value={draft.description.trim()} />
          {draft.mpesaCode.trim() ? (
            <ReviewRow label="M-Pesa code" value={draft.mpesaCode.trim()} />
          ) : null}
          {draft.etimsInvoiceNumber.trim() ? (
            <ReviewRow
              label="eTIMS invoice number"
              value={draft.etimsInvoiceNumber.trim()}
            />
          ) : null}
          {review.noReceiptReason ? (
            <ReviewRow
              label="No receipt because"
              value={review.noReceiptReason.trim()}
            />
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
                if (duplicate.expenseId) {
                  router.push({
                    pathname: "/claims/[claimId]",
                    params: { claimId: duplicate.expenseId },
                  });
                }
              }}
            />
          ) : null}
          <Button
            label={overspend ? "Save and submit the claim" : "Save spending"}
            loading={submitting}
            onPress={() => onSubmit(review)}
          />
          <Button
            label="Back to edit"
            variant="ghost"
            disabled={submitting}
            onPress={() => setReview(null)}
          />
        </View>
      </>
    );
  }

  return (
    <>
      <Text className="text-base text-gray-600">
        {kes(float.leftKes)} is left on your float.
      </Text>
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
      {hasEvidence ? null : (
        <View className="gap-3">
          <View className="min-h-14 flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-base text-gray-900">No receipt</Text>
            <Switch
              accessibilityLabel="No receipt"
              value={withoutReceipt.on}
              onValueChange={(on) =>
                setWithoutReceipt((current) => ({ ...current, on }))
              }
            />
          </View>
          {withoutReceipt.on ? (
            <>
              <TextField
                label="Why is there no receipt?"
                value={withoutReceipt.reason}
                onChangeText={(reason) =>
                  setWithoutReceipt((current) => ({ ...current, reason }))
                }
                placeholder="Kiosk gave no receipt"
                multiline
                maxLength={NO_RECEIPT_REASON_MAX_LENGTH}
              />
              <Text className="text-sm text-gray-600">
                Admins see it flagged “no receipt”.
              </Text>
            </>
          ) : null}
          <ErrorMessage message={fieldErrors.noReceiptReason ?? null} />
        </View>
      )}

      <View className="gap-4">
        <TextField
          label="Where did you pay?"
          value={draft.merchant}
          onChangeText={(value) => update("merchant", value)}
          placeholder="Shop, supplier or person"
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
        {overspend ? <OverspendNotice text={overspend} /> : null}

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
          categories={categoryList.data}
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
          placeholder="Printer paper for the office"
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

function OverspendNotice({ text }: { text: string }): JSX.Element {
  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-1 rounded-xl border border-amber-200 bg-amber-50 p-3"
    >
      <Text className="text-sm font-semibold text-amber-900">
        More than what’s left
      </Text>
      <Text className="text-sm text-amber-900">{text}</Text>
    </View>
  );
}
