import type { JSX } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ScanFace, Wallet } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import type {
  ClaimApproval,
  ClaimPaymentResult,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { KvGroup } from "~/components/kv-group";
import { LoadError } from "~/components/load-error";
import { Text } from "~/components/text";
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
import { ReviewShell } from "~/features/review/review-shell";
import { colors } from "~/theme/colors";

export default function PayClaimRoute(): JSX.Element {
  const router = useRouter();
  const { retry } = useLocalSearchParams<{ retry?: string }>();
  return (
    <RequireAdmin>
      {(company) => (
        <>
          <Stack.Screen options={{ headerShown: false }} />
          <ReviewShell
            title={retry === "1" ? "Retry payment" : "Approve and pay"}
            onBack={() => {
              router.back();
            }}
          >
            <ApprovalPasskeyGate>
              <PayFlow company={company} />
            </ApprovalPasskeyGate>
          </ReviewShell>
        </>
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
      <View className="gap-3">
        <LoadError
          message={describeApiError(prepared.error)}
          retrying={prepared.isFetching}
          onRetry={() => void prepared.refetch()}
        />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const { approval } = prepared.data;
  const topUpKes = approval.wallet.topUpKes;
  return (
    <View className="gap-5">
      <CostPreview approval={approval} />
      {topUpKes ? (
        <View className="gap-3 rounded-2xl bg-brand-50 p-4">
          <View className="flex-row items-start gap-3">
            <Wallet
              size={20}
              strokeWidth={1.75}
              color={colors.brandStrong}
              accessible={false}
            />
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-[16px] font-semibold text-gray-900">
                Top up KES {formatKesCents(topUpKes)}
              </Text>
              <Text className="text-[15px] leading-[21px] text-gray-900">
                The wallet doesn’t hold enough USDC for this payment. Add
                funds, then come back to pay.
              </Text>
            </View>
          </View>
          <Button
            label="Go to the wallet"
            variant="secondary"
            onPress={() => router.push("/wallet")}
          />
        </View>
      ) : null}
      {outcome?.status === "cancelled" ? (
        <Text className="text-[14px] text-gray-600">
          Cancelled. Nothing was sent.
        </Text>
      ) : null}
      <ErrorMessage
        message={pay.isError ? describePaymentError(pay.error) : null}
      />
      <View className="gap-3">
        <View className="flex-row items-center justify-center gap-1.5">
          <ScanFace
            size={16}
            strokeWidth={1.75}
            color={colors.muted}
            accessible={false}
          />
          <Text className="text-[13px] text-gray-600">
            You’ll confirm with your passkey
          </Text>
        </View>
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
        <KvGroup key={preview.claimId} rows={previewRows(preview)} />
      ))}
      <Text className="text-[14px] leading-5 text-gray-600">
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
          className="text-[24px] font-semibold leading-8 text-gray-900"
        >
          {summary.title}
        </Text>
        <Text className="text-[16px] leading-6 text-gray-600">
          {summary.body}
        </Text>
        {summary.failureReason ? (
          <Text className="text-[14px] text-gray-700">
            {summary.failureReason}
          </Text>
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
