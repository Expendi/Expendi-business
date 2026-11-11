import type { JSX, ReactNode } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Banknote,
  ArrowLeftRight,
  ReceiptText,
} from "lucide-react-native";
import { useCallback } from "react";
import { View } from "react-native";

import type { FloatSummary } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { GradientCard, WhiteMark, WhitePill } from "~/components/gradient-card";
import { KvGroup } from "~/components/kv-group";
import { LoadError } from "~/components/load-error";
import { Screen } from "~/components/screen";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { Text } from "~/components/text";
import { localIsoDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { balanceRows } from "./float-display";
import { movementRows, spendingRows } from "./my-petty-cash-rows";
import { useFloat, useFloats } from "./use-floats";

type Layout = "tab" | "stack";

/** The caller's open float, or else the one they held most recently. */
function currentFloat(floats: readonly FloatSummary[]): FloatSummary | null {
  return floats.find((float) => float.status === "open") ?? floats[0] ?? null;
}

function Frame({
  layout,
  refreshing = false,
  onRefresh,
  children,
}: {
  layout: Layout;
  refreshing?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
}): JSX.Element {
  return layout === "tab" ? (
    <TabScreen title="Petty cash" refreshing={refreshing} onRefresh={onRefresh}>
      {children}
    </TabScreen>
  ) : (
    <Screen belowHeader refreshing={refreshing} onRefresh={onRefresh}>
      {children}
    </Screen>
  );
}

/**
 * The holder's petty cash (spec §6.22): what's left, "Paid from petty
 * cash", and what they've spent from it. The employee's Petty cash tab, and
 * a pushed screen for admins.
 */
export function MyPettyCashScreen({
  company,
  layout,
}: {
  company: Company;
  layout: Layout;
}): JSX.Element {
  const floats = useFloats(company.organizationId, { mine: true });
  const { refetch } = floats;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  if (floats.isPending) {
    return (
      <Frame layout={layout}>
        <SoftGroupSkeleton rows={3} label="Loading your float" />
      </Frame>
    );
  }
  if (floats.isError) {
    return (
      <Frame layout={layout}>
        <LoadError
          message={describeApiError(floats.error)}
          retrying={floats.isFetching}
          onRetry={() => void refetch()}
        />
      </Frame>
    );
  }
  const float = currentFloat(floats.data.floats);
  if (!float) {
    return (
      <Frame
        layout={layout}
        refreshing={floats.isRefetching}
        onRefresh={() => void refetch()}
      >
        <EmptyState
          icon={Banknote}
          title="No petty cash float"
          message="When an admin issues you one, it’s paid to your M-Pesa and shows here."
        />
      </Frame>
    );
  }
  return (
    <FloatContent
      organizationId={company.organizationId}
      floatId={float.id}
      layout={layout}
    />
  );
}

function FloatContent({
  organizationId,
  floatId,
  layout,
}: {
  organizationId: string;
  floatId: string;
  layout: Layout;
}): JSX.Element {
  const router = useRouter();
  const detail = useFloat(organizationId, floatId);

  if (detail.isPending) {
    return (
      <Frame layout={layout}>
        <SoftGroupSkeleton rows={3} label="Loading your float" />
      </Frame>
    );
  }
  if (detail.isError) {
    return (
      <Frame layout={layout}>
        <LoadError
          message={describeApiError(detail.error)}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      </Frame>
    );
  }
  const float = detail.data;
  const today = localIsoDate(new Date());
  const spending = spendingRows(float, today);
  const movements = movementRows(float.movements, today);
  const open = (claimId: string): void =>
    router.push({ pathname: "/claims/[claimId]", params: { claimId } });

  return (
    <Frame
      layout={layout}
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <GradientCard height={150} vertical>
        <View className="flex-1 justify-between p-5">
          <View className="flex-row items-start justify-between gap-3">
            <WhitePill
              icon={Banknote}
              label={`${formatKesCents(float.leftKes)} left of ${formatKesCents(float.issuedKes)}`}
            />
            <WhiteMark size={30} />
          </View>
          <Text className="text-[15px] font-medium text-white">
            {float.status === "closed"
              ? "Closed"
              : `KES · ${formatKesCents(float.spentKes)} spent`}
          </Text>
        </View>
      </GradientCard>

      <View className="mt-4">
        {float.status === "open" ? (
          <Button
            label="Paid from petty cash"
            onPress={() =>
              router.push({
                pathname: "/petty-cash/new",
                params: { floatId: float.id },
              })
            }
          />
        ) : (
          <Text className="text-[15px] leading-5 text-gray-600">
            This float is closed. Paid for something yourself? Submit a
            reimbursement.
          </Text>
        )}
      </View>

      <View className="mt-7">
        <SectionHeader title="Balance" />
        <KvGroup rows={balanceRows(float)} />
        {float.onTheWayKes !== "0" ? (
          <Text className="mt-2 text-[14px] leading-5 text-gray-600">
            Money on its way counts once it reaches M-Pesa.
          </Text>
        ) : null}
      </View>

      <View className="mt-7">
        <SectionHeader title="Spending" />
        {spending.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="Nothing recorded yet"
            message="Add each purchase as you make it."
          />
        ) : (
          <SoftGroup>
            {spending.map(({ key, claimId, ...row }) => (
              <ItemRow
                key={key}
                {...row}
                icon={ReceiptText}
                onPress={claimId ? () => open(claimId) : undefined}
              />
            ))}
          </SoftGroup>
        )}
      </View>

      {movements.length > 0 ? (
        <View className="mt-7">
          <SectionHeader title="Money in and out" />
          <SoftGroup>
            {movements.map(({ key, ...row }) => (
              <ItemRow key={key} {...row} icon={ArrowLeftRight} />
            ))}
          </SoftGroup>
        </View>
      ) : null}
    </Frame>
  );
}
