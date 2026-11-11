import type { InfiniteData } from "@tanstack/react-query";
import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { MessageSquareText, ReceiptText, Wallet } from "lucide-react-native";
import { Image, View } from "react-native";

import type { ClaimDetail, ClaimsPage } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Avatar } from "~/components/avatar";
import { Button } from "~/components/button";
import { KvGroup } from "~/components/kv-group";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { SectionHeader } from "~/components/section-header";
import { SoftGroupSkeleton } from "~/components/soft-group";
import { Text } from "~/components/text";
import {
  AdminClaimActions,
  AdminClaimNotice,
  ApprovalDetails,
  PaymentNote,
} from "~/features/claims/claim-actions";
import { ClaimStatusBadge } from "~/features/claims/claim-status";
import { WarningList } from "~/features/claims/claim-warnings";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { RejectionNotice } from "~/features/claims/rejection-notice";
import { useClaim } from "~/features/claims/use-claims";
import { useOverview } from "~/features/overview/use-overview";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";
import { colors } from "~/theme/colors";
import {
  afterPaying,
  afterPayingParts,
  detailRows,
  etimsEvidence,
  queuePosition,
  queuePositionLabel,
  submittedLine,
} from "./review-display";
import { ReviewShell } from "./review-shell";

/**
 * One reimbursement (direction K1). An admin reviews it with the actions
 * fixed underneath; the person who submitted it sees where it stands.
 */
export function ClaimDetailScreen({
  company,
  claimId,
}: {
  company: Company;
  claimId: string;
}): JSX.Element {
  const router = useRouter();
  const claim = useClaim(company.organizationId, claimId);
  const queryClient = useQueryClient();
  const isAdmin = company.role === "admin";
  const queue = queryClient.getQueryData<InfiniteData<ClaimsPage>>(
    queryKeys.claimQueue(company.organizationId, "submitted"),
  );
  const position =
    isAdmin && queue
      ? queuePosition(
          queue.pages.flatMap((page) => page.claims.map((entry) => entry.id)),
          claimId,
        )
      : null;

  const header = (
    <Stack.Screen options={{ headerShown: false }} />
  );
  const back = (): void => {
    router.back();
  };

  if (claim.isPending) {
    return (
      <>
        {header}
        <ReviewShell title="Reimbursement" onBack={back}>
          <SoftGroupSkeleton rows={2} label="Loading the reimbursement" />
        </ReviewShell>
      </>
    );
  }
  if (claim.isError) {
    return (
      <>
        {header}
        <ReviewShell title="Reimbursement" onBack={back}>
          <LoadError
            message={describeApiError(claim.error)}
            retrying={claim.isFetching}
            onRetry={() => void claim.refetch()}
          />
        </ReviewShell>
      </>
    );
  }

  const data = claim.data;
  const adminCanAct =
    isAdmin && (data.status === "submitted" || data.status === "payout_failed");
  const editButton = data.canEdit ? (
    <Button
      label={
        data.status === "rejected"
          ? "Edit and resubmit"
          : "Edit reimbursement"
      }
      variant={data.status === "rejected" ? "primary" : "secondary"}
      onPress={() =>
        router.push({
          pathname: "/claims/[claimId]/edit",
          params: { claimId: data.id },
        })
      }
    />
  ) : null;
  const actions =
    adminCanAct || editButton ? (
      <View className="gap-3">
        {adminCanAct ? (
          <AdminClaimActions
            organizationId={company.organizationId}
            claim={data}
          />
        ) : null}
        {editButton}
      </View>
    ) : null;

  return (
    <>
      {header}
      <ReviewShell
        title="Reimbursement"
        onBack={back}
        right={
          position ? (
            <Text className="text-[15px] font-medium text-gray-500">
              {queuePositionLabel(position)}
            </Text>
          ) : undefined
        }
        footer={actions}
        refreshing={claim.isRefetching}
        onRefresh={() => void claim.refetch()}
      >
        <ClaimBody
          claim={data}
          organizationId={company.organizationId}
          isAdmin={isAdmin}
          onOpenClaim={(otherClaimId) =>
            router.push({
              pathname: "/claims/[claimId]",
              params: { claimId: otherClaimId },
            })
          }
        />
      </ReviewShell>
    </>
  );
}

function ClaimBody({
  claim,
  organizationId,
  isAdmin,
  onOpenClaim,
}: {
  claim: ClaimDetail;
  organizationId: string;
  isAdmin: boolean;
  onOpenClaim: (claimId: string) => void;
}): JSX.Element {
  const today = localIsoDate(new Date());
  const person = claim.submittedBy.name ?? claim.submittedBy.email;
  const showStatus = !isAdmin || claim.status !== "submitted";
  return (
    <View className="gap-5">
      <View>
        {isAdmin ? (
          <View className="flex-row items-center gap-3">
            <Avatar name={person} size={48} />
            <View className="min-w-0 flex-1">
              <Text className="text-[17px] font-semibold text-gray-900">
                {person}
              </Text>
              <Text className="text-[14px] text-gray-600">
                {submittedLine(claim.createdAt, today)}
              </Text>
            </View>
          </View>
        ) : null}
        <View className={isAdmin ? "mt-6" : ""}>
          <MoneyFigure code="KES" value={formatKesCents(claim.amountKes)} />
        </View>
        <Text className="mt-1 text-[15px] text-gray-600">
          {claim.merchant} · {formatShortDate(claim.spentOn, today)}
        </Text>
        {showStatus ? (
          <View className="mt-3">
            <ClaimStatusBadge status={claim.status} />
          </View>
        ) : null}
      </View>

      {claim.status === "submitted" && isAdmin ? (
        <AfterPayingCallout organizationId={organizationId} claim={claim} />
      ) : null}

      {claim.status === "rejected" && claim.rejectedReason ? (
        <RejectionNotice reason={claim.rejectedReason} />
      ) : null}
      {isAdmin ? <ApprovalDetails claim={claim} /> : <PaymentNote claim={claim} />}

      <WarningList warnings={claim.warnings} onOpenClaim={onOpenClaim} />
      {isAdmin ? <AdminClaimNotice claim={claim} /> : null}

      <View className="mt-2">
        <SectionHeader title="Evidence" />
        <Evidence claim={claim} today={today} />
      </View>
      <View>
        <SectionHeader title="Details" />
        <KvGroup rows={detailRows(claim, isAdmin)} />
      </View>
    </View>
  );
}

/** "After paying, KES X is available to 10 Dec." from the company's cash check. */
function AfterPayingCallout({
  organizationId,
  claim,
}: {
  organizationId: string;
  claim: ClaimDetail;
}): JSX.Element | null {
  const overview = useOverview(organizationId);
  if (!overview.data) return null;
  const outcome = afterPaying(overview.data.cash.availableKes, claim.amountKes);
  if (!outcome) return null;
  const parts = afterPayingParts(outcome, overview.data.cash.through);
  return (
    <View
      accessible
      accessibilityLabel={`${parts.before}${parts.amount}${parts.after}`}
      className="flex-row items-start gap-3 rounded-2xl bg-brand-50 p-4"
    >
      <Wallet
        size={20}
        strokeWidth={1.75}
        color={colors.brandStrong}
        accessible={false}
      />
      <Text className="min-w-0 flex-1 text-[15px] leading-[21px] text-gray-900">
        {parts.before}
        <Text
          className="font-semibold"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {parts.amount}
        </Text>
        {parts.after}
      </Text>
    </View>
  );
}

function Evidence({
  claim,
  today,
}: {
  claim: ClaimDetail;
  today: string;
}): JSX.Element {
  const etims = etimsEvidence(claim);
  const empty = claim.receipts.length === 0 && etims === null;
  if (empty) {
    return (
      <View className="rounded-3xl bg-gray-50 p-4">
        <Text className="text-[15px] text-gray-600">
          No receipt or message is attached.
        </Text>
      </View>
    );
  }
  return (
    <View className="gap-3">
      {claim.receipts.map((receipt) =>
        receipt.kind === "sms_text" ? (
          <View key={receipt.id} className="rounded-3xl bg-gray-50 p-4">
            <View className="flex-row items-center gap-3">
              <EvidenceIcon icon={MessageSquareText} />
              <View className="min-w-0 flex-1">
                <Text className="text-[16px] font-semibold text-gray-900">
                  M-Pesa message
                </Text>
                <Text className="text-[14px] text-gray-600">
                  {[claim.mpesaCode, formatShortDate(claim.spentOn, today)]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
            </View>
            <Text
              selectable
              className="mt-3 text-[15px] leading-[22px] text-gray-700"
            >
              {receipt.text}
            </Text>
          </View>
        ) : (
          <View key={receipt.id} className="overflow-hidden rounded-3xl bg-gray-50">
            <Image
              source={{ uri: receipt.url }}
              accessibilityLabel="Receipt photo"
              accessibilityIgnoresInvertColors
              className="w-full"
              style={{ aspectRatio: 3 / 4 }}
              resizeMode="contain"
            />
          </View>
        ),
      )}
      {etims ? (
        <View className="flex-row items-center gap-3 rounded-3xl bg-gray-50 p-4">
          <EvidenceIcon icon={ReceiptText} />
          <View className="min-w-0 flex-1">
            <Text className="text-[16px] font-semibold text-gray-900">
              {etims.title}
            </Text>
            <Text selectable className="text-[14px] text-gray-600">
              {etims.meta}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function EvidenceIcon({
  icon: Icon,
}: {
  icon: typeof MessageSquareText;
}): JSX.Element {
  return (
    <View
      accessible={false}
      className="h-11 w-11 items-center justify-center rounded-full bg-white"
    >
      <Icon size={20} strokeWidth={1.75} color={colors.brandStrong} />
    </View>
  );
}
