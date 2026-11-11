import type { JSX, ReactNode } from "react";
import { useFocusEffect } from "expo-router";
import { CircleCheck, Clock, Wallet } from "lucide-react-native";
import { useCallback } from "react";
import { View } from "react-native";

import type { MySalaryPayment } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { EmptyState } from "~/components/empty-state";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { Screen } from "~/components/screen";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { Text } from "~/components/text";
import { TrendLine } from "~/components/trend-line";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { paymentRowData } from "./payroll-overview";
import { useMySalaryPayments } from "./use-payroll";

/**
 * Only ever the signed-in person's own salary payments (spec §4). Renders as
 * the employee's Pay tab, or inside a pushed screen for admins.
 */
export function MyPayScreen({
  company,
  layout,
}: {
  company: Company;
  layout: "tab" | "stack";
}): JSX.Element {
  const payments = useMySalaryPayments(company.organizationId);
  const { refetch } = payments;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const content = payments.isPending ? (
    <SoftGroupSkeleton rows={3} label="Loading your salary payments" />
  ) : payments.isError ? (
    <LoadError
      message={describeApiError(payments.error)}
      retrying={payments.isFetching}
      onRetry={() => void refetch()}
    />
  ) : (
    <Payments payments={payments.data} companyName={company.name} />
  );

  return (
    <Frame
      layout={layout}
      refreshing={payments.isRefetching}
      onRefresh={() => void refetch()}
    >
      {content}
    </Frame>
  );
}

function Frame({
  layout,
  refreshing,
  onRefresh,
  children,
}: {
  layout: "tab" | "stack";
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}): JSX.Element {
  return layout === "tab" ? (
    <TabScreen title="Pay" refreshing={refreshing} onRefresh={onRefresh}>
      {children}
    </TabScreen>
  ) : (
    <Screen belowHeader refreshing={refreshing} onRefresh={onRefresh}>
      {children}
    </Screen>
  );
}

function Payments({
  payments,
  companyName,
}: {
  payments: readonly MySalaryPayment[];
  companyName: string;
}): JSX.Element {
  const today = localIsoDate(new Date());
  const latest = payments[0];
  if (!latest) {
    return (
      <EmptyState
        icon={Wallet}
        title="No salary payments yet"
        message={`Your salary payments from ${companyName} show here once they’re on their way.`}
      />
    );
  }
  const latestRow = paymentRowData(latest, today);
  const paidOn = formatShortDate(latest.paidOn ?? latest.payDate, today);
  return (
    <>
      <Text className="text-[16px] font-medium text-gray-600">
        Latest payment
      </Text>
      <View className="mt-2">
        <MoneyFigure code="KES" value={formatKesCents(latest.amountKes)} />
      </View>
      {latestRow.paid ? (
        <TrendLine direction="in" text={`Paid to you on ${paidOn}`} />
      ) : (
        <Text className="mt-1 text-[15px] leading-5 text-gray-600">
          {latestRow.meta}
        </Text>
      )}
      <View className="mt-8">
        <SectionHeader title="Salary payments" />
        <SoftGroup>
          {payments.map((payment) => {
            const row = paymentRowData(payment, today);
            return (
              <ItemRow
                key={payment.id}
                title={row.title}
                meta={row.meta}
                metaTone={row.metaTone}
                amount={row.amount}
                icon={row.paid ? CircleCheck : Clock}
                iconTone={row.paid ? "positive" : "neutral"}
              />
            );
          })}
        </SoftGroup>
      </View>
    </>
  );
}
