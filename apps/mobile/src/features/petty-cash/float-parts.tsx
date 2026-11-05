import type { JSX } from "react";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";

import type {
  FloatDetail,
  FloatMovement,
  FloatSpending,
  FloatSummary,
} from "@expendi-business/shared";

import { Badge } from "~/components/badge";
import { Text } from "~/components/text";
import { ClaimStatusBadge } from "~/features/claims/claim-status";
import { formatIsoDate, localIsoDate } from "~/features/claims/dates";
import {
  balanceRows,
  holderName,
  kes,
  MOVEMENT_LABELS,
  PHASE_LABELS,
} from "./float-display";

/** What's left, large, then what it's made of. */
export function FloatBalanceCard({
  float,
  showHolder = false,
}: {
  float: FloatSummary;
  showHolder?: boolean;
}): JSX.Element {
  return (
    <View
      accessibilityRole="summary"
      className="gap-4 rounded-2xl border border-gray-200 p-5"
    >
      <View className="gap-1">
        <Text className="text-sm font-medium text-gray-600">
          {showHolder ? `${holderName(float)} has left` : "Left on your float"}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          {kes(float.leftKes)}
        </Text>
        {float.status === "closed" ? <Badge label="Closed" /> : null}
      </View>
      <View className="gap-2">
        {balanceRows(float).map((row) => (
          <View key={row.label} className="flex-row justify-between gap-4">
            <Text className="flex-1 text-base text-gray-600">{row.label}</Text>
            <Text className="flex-1 text-right text-base font-semibold text-gray-900">
              {row.value}
            </Text>
          </View>
        ))}
      </View>
      {float.onTheWayKes !== "0" ? (
        <Text className="text-sm text-gray-600">
          Money on its way counts once it reaches M-Pesa.
        </Text>
      ) : null}
    </View>
  );
}

function SpendingRow({ spending }: { spending: FloatSpending }): JSX.Element {
  const router = useRouter();
  const claim = spending.overspendClaim;
  const body = (
    <>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {spending.merchant}
          </Text>
          <Text className="text-sm text-gray-600">
            {formatIsoDate(spending.spentOn)} · {spending.category.name}
          </Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">
          {kes(spending.amountKes)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {spending.noReceipt ? (
          <Badge label="No receipt" tone="warning" />
        ) : null}
        {claim ? (
          <Badge label={`${kes(claim.amountKes)} over, claimed`} />
        ) : null}
      </View>
      {spending.noReceiptReason ? (
        <Text className="text-sm text-gray-600">
          No receipt: {spending.noReceiptReason}
        </Text>
      ) : null}
    </>
  );
  if (!claim) {
    return (
      <View className="gap-2 rounded-xl border border-gray-200 px-4 py-3">
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${spending.merchant}, ${kes(spending.amountKes)}, open the claim for the extra`}
      onPress={() =>
        router.push({
          pathname: "/claims/[claimId]",
          params: { claimId: claim.id },
        })
      }
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      {body}
    </Pressable>
  );
}

/** Latest date first; spending over the float opens its claim. */
export function FloatSpendingList({
  float,
  emptyText,
}: {
  float: FloatDetail;
  emptyText: string;
}): JSX.Element {
  const router = useRouter();
  const loneClaims = float.overspendClaims.filter(
    (claim) =>
      !float.spending.some(
        (spending) => spending.overspendClaim?.id === claim.id,
      ),
  );
  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Spending
      </Text>
      {float.spending.length === 0 && loneClaims.length === 0 ? (
        <Text className="text-base text-gray-600">{emptyText}</Text>
      ) : null}
      {float.spending.map((spending) => (
        <SpendingRow key={spending.id} spending={spending} />
      ))}
      {loneClaims.map((claim) => (
        <Pressable
          key={claim.id}
          accessibilityRole="button"
          accessibilityLabel={`${claim.merchant}, ${kes(claim.amountKes)} claimed`}
          onPress={() =>
            router.push({
              pathname: "/claims/[claimId]",
              params: { claimId: claim.id },
            })
          }
          className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
        >
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1 gap-0.5">
              <Text className="text-base font-semibold text-gray-900">
                {claim.merchant}
              </Text>
              <Text className="text-sm text-gray-600">
                {formatIsoDate(claim.spentOn)} · Claimed, nothing was left
              </Text>
            </View>
            <Text className="text-base font-semibold text-gray-900">
              {kes(claim.amountKes)}
            </Text>
          </View>
          <ClaimStatusBadge status={claim.status} />
        </Pressable>
      ))}
    </View>
  );
}

const PHASE_TONES = {
  awaiting_approval: "neutral",
  on_its_way: "neutral",
  paid: "success",
  failed: "warning",
  recorded: "neutral",
} as const;

export function MovementRow({
  movement,
  action,
}: {
  movement: FloatMovement;
  action?: JSX.Element | null;
}): JSX.Element {
  return (
    <View className="gap-2 rounded-xl border border-gray-200 px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {MOVEMENT_LABELS[movement.type]}
          </Text>
          <Text className="text-sm text-gray-600">
            {formatIsoDate(localIsoDate(new Date(movement.createdAt)))} ·{" "}
            {movement.recordedBy}
          </Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">
          {kes(movement.amountKes)}
        </Text>
      </View>
      <Badge
        label={PHASE_LABELS[movement.phase]}
        tone={PHASE_TONES[movement.phase]}
      />
      {movement.note ? (
        <Text className="text-sm text-gray-600">{movement.note}</Text>
      ) : null}
      {movement.payout?.failureReason && movement.phase === "failed" ? (
        <Text className="text-sm text-gray-700">
          {movement.payout.failureReason}
        </Text>
      ) : null}
      {action ?? null}
    </View>
  );
}
