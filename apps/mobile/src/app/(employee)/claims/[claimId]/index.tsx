import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Image, Text, View } from "react-native";

import type { ClaimDetail, EtimsStatus } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { ReviewRow } from "~/features/claims/claim-editor";
import { ClaimStatusBadge } from "~/features/claims/claim-status";
import { WarningList } from "~/features/claims/claim-warnings";
import { formatIsoDate } from "~/features/claims/dates";
import { RejectionNotice } from "~/features/claims/rejection-notice";
import { RequireCompany } from "~/features/claims/require-company";
import { useClaim } from "~/features/claims/use-claims";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

const ETIMS_LABELS: Record<EtimsStatus, string> = {
  attached: "Invoice attached",
  not_required: "Not needed for this category",
  none: "No invoice",
};

export default function ClaimRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <ClaimScreen company={company} />}
    </RequireCompany>
  );
}

function ClaimScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { claimId } = useLocalSearchParams<{ claimId: string }>();
  const claim = useClaim(company.organizationId, claimId);

  if (claim.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the claim" />
      </Screen>
    );
  }
  if (claim.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(claim.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={claim.isFetching}
          onPress={() => void claim.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={claim.isRefetching}
      onRefresh={() => void claim.refetch()}
    >
      <ClaimDetails
        claim={claim.data}
        showSubmitter={company.role === "admin"}
      />
      <WarningList
        warnings={claim.data.warnings}
        onOpenClaim={(otherClaimId) =>
          router.push({
            pathname: "/claims/[claimId]",
            params: { claimId: otherClaimId },
          })
        }
      />
      {claim.data.canEdit ? (
        <Button
          label={
            claim.data.status === "rejected"
              ? "Edit and resubmit"
              : "Edit claim"
          }
          variant={claim.data.status === "rejected" ? "primary" : "secondary"}
          onPress={() =>
            router.push({
              pathname: "/claims/[claimId]/edit",
              params: { claimId: claim.data.id },
            })
          }
        />
      ) : null}
    </Screen>
  );
}

function ClaimDetails({
  claim,
  showSubmitter,
}: {
  claim: ClaimDetail;
  showSubmitter: boolean;
}): JSX.Element {
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {claim.merchant}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          KES {formatKesCents(claim.amountKes)}
        </Text>
        <ClaimStatusBadge status={claim.status} />
      </View>

      {claim.status === "rejected" && claim.rejectedReason ? (
        <RejectionNotice reason={claim.rejectedReason} />
      ) : null}

      <View className="gap-4">
        {showSubmitter ? (
          <ReviewRow
            label="Submitted by"
            value={claim.submittedBy.name ?? claim.submittedBy.email}
          />
        ) : null}
        <ReviewRow label="Date paid" value={formatIsoDate(claim.spentOn)} />
        <ReviewRow label="Category" value={claim.category.name} />
        {claim.description ? (
          <ReviewRow label="What it was for" value={claim.description} />
        ) : null}
        {claim.mpesaCode ? (
          <ReviewRow label="M-Pesa code" value={claim.mpesaCode} />
        ) : null}
        <ReviewRow
          label="eTIMS"
          value={
            claim.etimsInvoiceNumber
              ? `${ETIMS_LABELS[claim.etimsStatus]}: ${claim.etimsInvoiceNumber}`
              : ETIMS_LABELS[claim.etimsStatus]
          }
        />
        {claim.etimsSupplierPin ? (
          <ReviewRow
            label="Supplier’s KRA PIN"
            value={claim.etimsSupplierPin}
          />
        ) : null}
        {claim.etimsQrPayload ? (
          <ReviewRow label="eTIMS QR code" value="Scanned" />
        ) : null}
      </View>

      <View className="gap-3">
        <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          {claim.receipts.length === 1 ? "Receipt" : "Receipts"}
        </Text>
        {claim.receipts.map((receipt) =>
          receipt.kind === "sms_text" ? (
            <View
              key={receipt.id}
              className="gap-1 rounded-xl border border-gray-200 p-3"
            >
              <Text className="text-sm font-medium text-gray-700">
                M-Pesa SMS
              </Text>
              <Text selectable className="text-sm text-gray-600">
                {receipt.text}
              </Text>
            </View>
          ) : (
            <Image
              key={receipt.id}
              source={{ uri: receipt.url }}
              accessibilityLabel="Receipt"
              accessibilityIgnoresInvertColors
              className="w-full rounded-xl bg-gray-100"
              style={{ aspectRatio: 3 / 4 }}
              resizeMode="contain"
            />
          ),
        )}
      </View>
    </>
  );
}
