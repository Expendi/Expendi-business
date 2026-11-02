import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import type { MarkBillPaidOutsideRequest } from "@expendi-business/shared";
import {
  BILL_NOTES_MAX_LENGTH,
  markBillPaidOutsideRequestSchema,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { blankToNull } from "~/features/bills/bill-draft";
import { useMarkBillPaidOutside } from "~/features/bills/use-bills";
import { localIsoDate } from "~/features/claims/dates";
import { ReceiptPicker } from "~/features/claims/receipt-picker";
import { useReceiptSlots } from "~/features/claims/use-receipt-slots";
import { RequireAdmin } from "~/features/company/require-admin";
import { PaidFromAccountPicker } from "~/features/spending/paid-from-account-picker";
import { useInvalidateCompanySpending } from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";

export default function MarkBillPaidRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <MarkBillPaidScreen company={company} />}
    </RequireAdmin>
  );
}

/** The admin paid the bill another way, e.g. by card or bank transfer (spec §6.20). */
function MarkBillPaidScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { billId } = useLocalSearchParams<{ billId: string }>();
  const markPaid = useMarkBillPaidOutside(company.organizationId, billId);
  const refreshSpending = useInvalidateCompanySpending(company.organizationId);
  const proof = useReceiptSlots(company.organizationId);
  const [paidOn, setPaidOn] = useState(() => localIsoDate(new Date()));
  const [note, setNote] = useState("");
  const [paidFromAccountId, setPaidFromAccountId] = useState<string | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const failedUploads = proof.slots.some((slot) => slot.status === "failed");

  function submit(): void {
    const request: MarkBillPaidOutsideRequest = {
      paidOn: paidOn.trim(),
      note: blankToNull(note),
      receiptFileIds: proof.receiptFileIds,
      paidFromAccountId,
    };
    const parsed = markBillPaidOutsideRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the details.");
      return;
    }
    setFormError(null);
    markPaid.mutate(request, {
      onSuccess: () => {
        void refreshSpending();
        router.back();
      },
    });
  }

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        Record a bill you paid outside Expendi, e.g. by card or from the bank.
        Nothing is sent from the wallet. It’s also recorded as company spending.
      </Text>

      <View className="gap-4">
        <TextField
          label="Date paid (YYYY-MM-DD)"
          value={paidOn}
          onChangeText={setPaidOn}
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          maxLength={10}
        />
        <TextField
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="Paid with the company card"
          multiline
          maxLength={BILL_NOTES_MAX_LENGTH}
        />
      </View>

      <PaidFromAccountPicker
        organizationId={company.organizationId}
        value={paidFromAccountId}
        onChange={setPaidFromAccountId}
        optional
      />

      <ReceiptPicker receipts={proof} label="Proof of payment (optional)" />

      <View className="gap-3">
        {failedUploads ? (
          <ErrorMessage message="Retry or remove the photo that didn’t upload." />
        ) : null}
        <ErrorMessage
          message={
            formError ??
            (markPaid.isError ? describeApiError(markPaid.error) : null)
          }
        />
        <Button
          label={proof.uploading ? "Uploading photo…" : "Mark as paid"}
          loading={markPaid.isPending}
          disabled={proof.uploading || failedUploads}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}
