import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import type { FloatApproval } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { ApprovalPasskeyGate } from "~/features/approval";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  floatPaymentOutcome,
  kes,
  MOVEMENT_LABELS,
  PAYMENT_OUTCOMES,
  paymentRows,
} from "~/features/petty-cash/float-display";
import {
  describeFloatPaymentError,
  useFloatPayment,
  usePayFloat,
} from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayFloatRoute(): JSX.Element {
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
 * Approve & pay for an issue or top-up (spec §6.7, §6.22): the cost, then
 * the admin's passkey, then where the payment stands. A failed one is paid
 * again as a new payment that needs the passkey again (spec §6.8).
 */
function PayFlow({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { floatId, movementId } = useLocalSearchParams<{
    floatId: string;
    movementId: string;
  }>();
  const prepared = useFloatPayment(company.organizationId, floatId, movementId);
  const pay = usePayFloat(company.organizationId);
  const outcome = pay.data;

  if (outcome?.status === "approved") {
    const result = floatPaymentOutcome(outcome.result);
    const summary = PAYMENT_OUTCOMES[result];
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
          {result === "failed" &&
          outcome.result.movement.payout?.failureReason ? (
            <Text className="text-sm text-gray-700">
              {outcome.result.movement.payout.failureReason}
            </Text>
          ) : null}
        </View>
        {result === "failed" ? (
          <Button
            label="Retry payment"
            onPress={() => {
              pay.reset();
              void prepared.refetch();
            }}
          />
        ) : null}
        <Button
          label="Done"
          variant={result === "failed" ? "secondary" : "primary"}
          onPress={() =>
            router.replace({
              pathname: "/petty-cash/floats/[floatId]",
              params: { floatId },
            })
          }
        />
      </View>
    );
  }
  if (prepared.isPending) {
    return <ActivityIndicator accessibilityLabel="Working out the cost" />;
  }
  if (prepared.isError) {
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

  const { approval } = prepared.data;
  const topUpKes = approval.wallet.topUpKes;
  return (
    <View className="gap-6">
      <View className="gap-1">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {MOVEMENT_LABELS[approval.movement.type]}{" "}
          {kes(approval.payment.requestedKes)}
        </Text>
        <Text className="text-base text-gray-600">
          Petty cash for {approval.payment.holderName}. It counts toward the
          float once it reaches their M-Pesa.
        </Text>
      </View>
      <CostPreview approval={approval} />
      {topUpKes ? (
        <View className="gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <Text className="text-lg font-bold text-amber-900">
            Top up KES {formatKesCents(topUpKes)}
          </Text>
          <Text className="text-base text-amber-900">
            The wallet doesn’t hold enough USDC for this payment. Add funds,
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
        message={pay.isError ? describeFloatPaymentError(pay.error) : null}
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

function CostPreview({ approval }: { approval: FloatApproval }): JSX.Element {
  return (
    <View className="gap-4">
      <View className="gap-3 rounded-2xl border border-gray-200 p-5">
        {paymentRows(approval.payment).map((row) => (
          <View key={row.label} className="flex-row justify-between gap-4">
            <Text className="flex-1 text-base text-gray-600">{row.label}</Text>
            <Text className="flex-1 text-right text-base font-semibold text-gray-900">
              {row.value}
            </Text>
          </View>
        ))}
      </View>
      <Text className="text-sm text-gray-600">
        The exact fee is known when the cash-out is sent. What isn’t used stays
        in the wallet.
      </Text>
    </View>
  );
}
