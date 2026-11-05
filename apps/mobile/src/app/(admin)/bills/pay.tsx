import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import type {
  BillPayment,
  BillPaymentResult,
  PayeeChangeHold,
} from "@expendi-business/shared";

import type { PreviewRow } from "~/features/claims/payment";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { ApprovalPasskeyGate } from "~/features/approval";
import {
  billPreviewRows,
  billTotalRows,
  describeBillPaymentResult,
  holdFrom,
  holdWarning,
  joinBillIds,
  splitBillIds,
} from "~/features/bills/bill-payment";
import {
  describeBillPaymentError,
  useBillPayment,
  usePayBills,
} from "~/features/bills/use-bill-payment";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayBillsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <ApprovalPasskeyGate>
            <PayFlow company={company} />
          </ApprovalPasskeyGate>
        </Screen>
      )}
    </RequireAdmin>
  );
}

/**
 * Pay and Pay all (spec §6.20): the cost of each bill and the total, a
 * second confirmation when a payee's details changed in the last 24 hours
 * (spec §6.19), then the admin's passkey, then where each payment stands.
 * `?retry=1` pays one bill whose payment failed, as a new payment that
 * needs the passkey again.
 */
function PayFlow({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const params = useLocalSearchParams<{ billIds: string; retry?: string }>();
  const billIds = splitBillIds(params.billIds);
  const [secondConfirmation, setSecondConfirmation] = useState(false);
  const request = { billIds, retry: params.retry === "1", secondConfirmation };
  const prepared = useBillPayment(company.organizationId, request);
  const pay = usePayBills(company.organizationId, request);
  const outcome = pay.data;

  if (outcome?.status === "approved") {
    return (
      <PaymentResult
        result={outcome.result}
        onRetry={(billId) => {
          pay.reset();
          router.replace({
            pathname: "/bills/pay",
            params: { billIds: joinBillIds([billId]), retry: "1" },
          });
        }}
        onDone={() => router.back()}
      />
    );
  }
  if (prepared.isPending) {
    return <ActivityIndicator accessibilityLabel="Working out the cost" />;
  }
  if (prepared.isError) {
    const hold = holdFrom(prepared.error);
    if (hold && !secondConfirmation) {
      return (
        <HoldWarning
          hold={hold}
          onConfirm={() => setSecondConfirmation(true)}
          onBack={() => router.back()}
        />
      );
    }
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(prepared.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={prepared.isFetching}
          onPress={() => void prepared.refetch()}
        />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const { payment } = prepared.data;
  const topUpKes = payment.wallet.topUpKes;
  const title = request.retry
    ? "Retry the payment"
    : payment.bills.length === 1
      ? "Pay bill"
      : `Pay ${payment.bills.length} bills`;
  return (
    <View className="gap-6">
      <Text
        accessibilityRole="header"
        className="text-2xl font-bold text-gray-900"
      >
        {title}
      </Text>
      <CostPreview payment={payment} />
      {topUpKes ? (
        <View className="gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <Text className="text-lg font-bold text-amber-900">
            Top up KES {formatKesCents(topUpKes)}
          </Text>
          <Text className="text-base text-amber-900">
            The wallet doesn’t hold enough USDC for these payments. Add funds,
            then come back to pay.
          </Text>
          <Button
            label="Go to the wallet"
            variant="secondary"
            onPress={() => router.push("/wallet")}
          />
        </View>
      ) : null}
      {outcome?.status === "cancelled" ? (
        <Text className="text-sm text-gray-600">
          Cancelled. Nothing was sent.
        </Text>
      ) : null}
      <ErrorMessage
        message={pay.isError ? describeBillPaymentError(pay.error) : null}
      />
      <View className="gap-3">
        <Button
          label="Pay with passkey"
          disabled={topUpKes !== null || prepared.isFetching}
          loading={pay.isPending}
          onPress={() =>
            pay.mutate(prepared.data, {
              onError: () => void prepared.refetch(),
            })
          }
        />
        <Button
          label="Back"
          variant="ghost"
          disabled={pay.isPending}
          onPress={() => router.back()}
        />
      </View>
    </View>
  );
}

function Rows({ rows }: { rows: readonly PreviewRow[] }): JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <View key={row.label} className="flex-row justify-between gap-4">
          <Text className="flex-1 text-base text-gray-600">{row.label}</Text>
          <Text className="flex-1 text-right text-base font-semibold text-gray-900">
            {row.value}
          </Text>
        </View>
      ))}
    </>
  );
}

function CostPreview({ payment }: { payment: BillPayment }): JSX.Element {
  return (
    <View className="gap-4">
      {payment.bills.map((preview) => (
        <View
          key={preview.billId}
          className="gap-3 rounded-2xl border border-gray-200 p-5"
        >
          <Text className="text-lg font-semibold text-gray-900">
            {preview.payeeName}
          </Text>
          <Rows rows={billPreviewRows(preview)} />
        </View>
      ))}
      {payment.bills.length > 1 ? (
        <View className="gap-3 rounded-2xl bg-gray-50 p-5">
          <Text className="text-lg font-semibold text-gray-900">Total</Text>
          <Rows rows={billTotalRows(payment)} />
        </View>
      ) : null}
      <Text className="text-sm text-gray-600">
        One passkey confirmation pays them all, each on its own: if one fails,
        the others still go through. Paycrest states its exact fee when each
        payment is made; what isn’t used stays in the wallet.
      </Text>
    </View>
  );
}

function HoldWarning({
  hold,
  onConfirm,
  onBack,
}: {
  hold: PayeeChangeHold;
  onConfirm: () => void;
  onBack: () => void;
}): JSX.Element {
  const [checked, setChecked] = useState(false);
  const warning = holdWarning(hold);
  return (
    <View className="gap-6">
      <View className="gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <Text
          accessibilityRole="header"
          className="text-lg font-bold text-amber-900"
        >
          {warning.title}
        </Text>
        <Text className="text-base text-amber-900">{warning.body}</Text>
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => setChecked((value) => !value)}
        className="flex-row items-start gap-3"
      >
        <View
          className={`mt-0.5 h-6 w-6 items-center justify-center rounded border-2 ${checked ? "border-gray-900 bg-gray-900" : "border-gray-400"}`}
        >
          {checked ? <Text className="text-sm text-white">✓</Text> : null}
        </View>
        <Text className="flex-1 text-base text-gray-900">
          {warning.confirmLabel}
        </Text>
      </Pressable>
      <View className="gap-3">
        <Button label="Continue" disabled={!checked} onPress={onConfirm} />
        <Button label="Back" variant="ghost" onPress={onBack} />
      </View>
    </View>
  );
}

function PaymentResult({
  result,
  onRetry,
  onDone,
}: {
  result: BillPaymentResult;
  onRetry: (billId: string) => void;
  onDone: () => void;
}): JSX.Element {
  const summary = describeBillPaymentResult(result);
  const [failed] = summary.failedBillIds;
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {summary.title}
        </Text>
        <Text className="text-base text-gray-600">{summary.body}</Text>
        {summary.failureReason ? (
          <Text className="text-sm text-gray-700">{summary.failureReason}</Text>
        ) : null}
      </View>
      {failed !== undefined && summary.failedBillIds.length === 1 ? (
        <Button
          label="Retry the failed payment"
          onPress={() => onRetry(failed)}
        />
      ) : null}
      {summary.failedBillIds.length > 1 ? (
        <Text className="text-sm text-gray-600">
          Retry each failed bill from the bills list.
        </Text>
      ) : null}
      <Button
        label="Done"
        variant={summary.outcome === "failed" ? "secondary" : "primary"}
        onPress={onDone}
      />
    </View>
  );
}
