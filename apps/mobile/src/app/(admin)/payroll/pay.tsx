import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import type {
  PayeeChangeHold,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";

import type { PreviewRow } from "~/features/claims/payment";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { ApprovalPasskeyGate } from "~/features/approval";
import { holdFrom, holdWarning } from "~/features/bills/bill-payment";
import { describeBillPaymentError } from "~/features/bills/use-bill-payment";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  capRows,
  failedPayments,
  personRows,
  progressInWords,
} from "~/features/payroll/payroll-payment";
import {
  usePayPayroll,
  usePayrollPayment,
} from "~/features/payroll/use-payroll-payment";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayPayrollRoute(): JSX.Element {
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
 * Approve & pay all (spec §6.21): each person and the total against the
 * run's cap, a second confirmation for anyone whose details changed in the
 * last 24 hours (spec §6.19), the admin's passkey, then how far the run
 * has got. `?billId=` retries that one person, nobody else.
 */
function PayFlow({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const params = useLocalSearchParams<{ runId: string; billId?: string }>();
  const [secondConfirmation, setSecondConfirmation] = useState(false);
  const request = {
    runId: params.runId,
    retryBillId: params.billId ?? null,
    secondConfirmation,
  };
  const prepared = usePayrollPayment(company.organizationId, request);
  const pay = usePayPayroll(company.organizationId, request);
  const outcome = pay.data;

  if (outcome?.status === "approved") {
    return <Progress run={outcome.result} onDone={() => router.back()} />;
  }
  if (prepared.isPending) {
    return <ActivityIndicator accessibilityLabel="Working out the payroll" />;
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
  const blocked = topUpKes !== null || !payment.cap.withinCap;
  return (
    <View className="gap-6">
      <Text
        accessibilityRole="header"
        className="text-2xl font-bold text-gray-900"
      >
        {request.retryBillId === null
          ? "Approve & pay all"
          : "Retry this payment"}
      </Text>
      <Summary payment={payment} />
      {!payment.cap.withinCap ? (
        <Text className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          This is over the run’s cap of KES {formatKesCents(payment.cap.capKes)}
          , so it can’t be paid. Lower someone’s pay, leave someone out, or
          raise the payroll margin.
        </Text>
      ) : null}
      {topUpKes ? (
        <View className="gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <Text className="text-lg font-bold text-amber-900">
            Top up KES {formatKesCents(topUpKes)}
          </Text>
          <Text className="text-base text-amber-900">
            The wallet doesn’t hold enough USDC for this payroll. Add funds,
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
          disabled={blocked || prepared.isFetching}
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

function Summary({ payment }: { payment: PayrollRunPayment }): JSX.Element {
  return (
    <View className="gap-4">
      <View className="gap-3 rounded-2xl bg-gray-50 p-5">
        <Rows rows={capRows(payment)} />
      </View>
      {payment.people.map((person) => (
        <View
          key={person.billId}
          className="gap-3 rounded-2xl border border-gray-200 p-5"
        >
          <Text className="text-lg font-semibold text-gray-900">
            {person.payeeName}
          </Text>
          <Rows rows={personRows(person)} />
        </View>
      ))}
      <Text className="text-sm text-gray-600">
        One passkey confirmation pays everyone, each on their own: if one
        payment fails, the others still go through, and you retry only that
        person.
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

function Progress({
  run,
  onDone,
}: {
  run: PayrollRunDetail;
  onDone: () => void;
}): JSX.Element {
  const failed = failedPayments(run);
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {failed.length > 0 ? "Some payments failed" : "Payroll sent"}
        </Text>
        <Text className="text-base text-gray-600">
          {progressInWords(run) ?? ""}
        </Text>
        <Text className="text-base text-gray-600">
          {failed.length > 0
            ? "Nothing reached the people whose payment failed. Retry each of them from the run; nobody else is paid again."
            : "M-Pesa payments usually arrive within a minute or two; banks can take longer."}
        </Text>
      </View>
      <Button label="Back to the run" onPress={onDone} />
    </View>
  );
}
