import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";

import type {
  ClaimApproval,
  ClaimPaymentResult,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { ApprovalPasskeyGate } from "~/features/approval";
import { describePaymentResult, previewRows } from "~/features/claims/payment";
import {
  describePaymentError,
  useClaimPayment,
  usePayClaim,
} from "~/features/claims/use-claim-approval";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayClaimRoute(): JSX.Element {
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
 * Approve & pay (spec §6.7): the cost first, then the admin's passkey, then
 * where the payment stands. `?retry=1` pays a claim whose payment failed,
 * as a new payment that needs the passkey again (spec §6.8).
 */
function PayFlow({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { claimId, retry } = useLocalSearchParams<{
    claimId: string;
    retry?: string;
  }>();
  const isRetry = retry === "1";
  const prepared = useClaimPayment(company.organizationId, claimId, isRetry);
  const pay = usePayClaim(company.organizationId, claimId, isRetry);
  const outcome = pay.data;

  if (outcome?.status === "approved") {
    return (
      <PaymentResult
        result={outcome.result}
        onRetry={() => {
          pay.reset();
          router.replace({
            pathname: "/approvals/[claimId]/pay",
            params: { claimId, retry: "1" },
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
      <Text
        accessibilityRole="header"
        className="text-2xl font-bold text-gray-900"
      >
        {isRetry ? "Retry the payment" : "Approve & pay"}
      </Text>
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
        message={pay.isError ? describePaymentError(pay.error) : null}
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

function CostPreview({ approval }: { approval: ClaimApproval }): JSX.Element {
  return (
    <View className="gap-4">
      {approval.claims.map((preview) => (
        <View
          key={preview.claimId}
          className="gap-3 rounded-2xl border border-gray-200 p-5"
        >
          {previewRows(preview).map((row) => (
            <View key={row.label} className="flex-row justify-between gap-4">
              <Text className="text-base text-gray-600">{row.label}</Text>
              <Text className="flex-1 text-right text-base font-semibold text-gray-900">
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ))}
      <Text className="text-sm text-gray-600">
        Paycrest states its exact fee when the payment is made. What isn’t used
        stays in the wallet.
      </Text>
    </View>
  );
}

function PaymentResult({
  result,
  onRetry,
  onDone,
}: {
  result: ClaimPaymentResult;
  onRetry: () => void;
  onDone: () => void;
}): JSX.Element {
  const summary = describePaymentResult(result);
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
      {summary.outcome === "failed" ? (
        <Button label="Retry payment" onPress={onRetry} />
      ) : null}
      <Button
        label="Done"
        variant={summary.outcome === "failed" ? "secondary" : "primary"}
        onPress={onDone}
      />
    </View>
  );
}
