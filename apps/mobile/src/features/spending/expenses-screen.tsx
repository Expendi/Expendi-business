import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Building2,
  ChevronDown,
  CircleAlert,
  Landmark,
  Plus,
  Receipt,
  ReceiptText,
  Repeat,
  Wallet,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import type { SpendingOverview } from "@expendi-business/shared";

import type { ItemRowProps } from "~/components/soft-group";
import type { Company } from "~/features/company/company-provider";
import type { ExpenseFilter } from "./expenses-display";
import { EmptyState } from "~/components/empty-state";
import { FilterPills } from "~/components/filter-pills";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { PillButton } from "~/components/pill-button";
import { RoundButton } from "~/components/round-button";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { Text } from "~/components/text";
import { localIsoDate } from "~/features/claims/dates";
import { useOverview } from "~/features/overview/use-overview";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import {
  categoriesSpent,
  comparisonLine,
  EXPENSE_FILTERS,
  filterPayments,
  headingBars,
  monthChoices,
  monthName,
  paymentMeta,
  spentLabel,
} from "./expenses-display";
import { MonthSheet } from "./month-sheet";

const KIND_ICONS = {
  claim: ReceiptText,
  float: Wallet,
  company: Building2,
  bill: Repeat,
} as const;

/**
 * Expenses: money already spent. This month's breakdown by heading and
 * category, then the latest payments to filter.
 */
export function ExpensesScreen({
  company,
  initialMonth = "",
}: {
  company: Company;
  /** `YYYY-MM`, or "" for this month. */
  initialMonth?: string;
}): JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(initialMonth);
  const [choosing, setChoosing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const overview = useOverview(company.organizationId, month);
  const { refetch } = overview;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", company.organizationId],
      });
    } finally {
      setRefreshing(false);
    }
  }

  const currentMonth =
    overview.data?.cash.today.slice(0, 7) ?? localIsoDate(new Date()).slice(0, 7);
  const shownMonth = overview.data?.month ?? (month === "" ? currentMonth : month);

  return (
    <TabScreen
      title="Expenses"
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      right={
        <>
          <PillButton
            label={monthName(shownMonth, currentMonth)}
            trailingIcon={ChevronDown}
            accessibilityLabel={`Month, ${monthName(shownMonth, currentMonth)}. Change month`}
            onPress={() => setChoosing(true)}
          />
          <RoundButton
            icon={Plus}
            label="Record spending"
            tone="brand"
            onPress={() => router.push("/spending/new")}
          />
        </>
      }
    >
      {overview.isPending ? (
        <ExpensesSkeleton />
      ) : overview.isError ? (
        <LoadError
          message={describeApiError(overview.error)}
          retryLabel="Try expenses again"
          retrying={overview.isFetching}
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <ExpensesContent data={overview.data} />
      )}
      <MonthSheet
        visible={choosing}
        choices={monthChoices(currentMonth)}
        value={month}
        onSelect={(value) => {
          setMonth(value);
          setChoosing(false);
        }}
        onClose={() => setChoosing(false)}
      />
    </TabScreen>
  );
}

function ExpensesContent({ data }: { data: SpendingOverview }): JSX.Element {
  const router = useRouter();
  const [filter, setFilter] = useState<ExpenseFilter>("all");
  const bars = headingBars(data);
  const categories = categoriesSpent(data);
  const payments = filterPayments(data.recentPayments, filter);
  const rows = payments.map((payment): ItemRowProps & { key: string } => {
    const meta = paymentMeta(payment, data);
    const opensSpending =
      payment.channel === "outside" &&
      (payment.kind === "company" || payment.kind === "bill");
    const opensBill = payment.kind === "bill" && payment.channel === "expendi";
    return {
      key: payment.id,
      title: payment.name,
      meta: meta.text,
      metaTone: meta.noReceipt ? "negative" : "default",
      amount: formatKesCents(payment.amountKes),
      icon: meta.noReceipt ? CircleAlert : KIND_ICONS[payment.kind],
      iconTone: meta.noReceipt ? "negative" : "brand",
      ...(opensSpending
        ? {
            onPress: () =>
              router.push({
                pathname: "/spending/[spendingId]",
                params: { spendingId: payment.id },
              }),
          }
        : opensBill
          ? {
              onPress: () =>
                router.push({
                  pathname: "/bills/[billId]",
                  params: { billId: payment.subjectId },
                }),
            }
          : {}),
    };
  });

  return (
    <>
      <Text className="text-[16px] font-medium text-gray-600">
        {spentLabel(data)}
      </Text>
      <View className="mt-1">
        <MoneyFigure code="KES" value={formatKesCents(data.currentKes)} />
      </View>
      <Text
        className="mt-1 text-[14px] text-gray-500"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {comparisonLine(data)}
      </Text>

      <View
        className="mt-5 gap-4 rounded-3xl bg-gray-50 p-4"
        accessibilityLabel="Spending by heading"
      >
        {bars.map((bar) => (
          <View
            key={bar.id}
            accessible
            accessibilityLabel={`${bar.name}, ${bar.amount}${bar.note ? `, ${bar.note}` : ""}`}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="flex-1 text-[15px] font-medium text-gray-900">
                {bar.name}
              </Text>
              <Text
                className="text-[15px] font-semibold text-gray-900"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {bar.amount}
              </Text>
            </View>
            {bar.note ? (
              <Text className="mt-1 text-[13px] text-gray-500">{bar.note}</Text>
            ) : (
              <View className="mt-2 h-2 flex-row overflow-hidden rounded-full bg-gray-200">
                {bar.permille === 0 ? null : (
                  <View
                    className="h-2 rounded-full bg-brand-500"
                    style={{ flex: bar.permille }}
                  />
                )}
                <View style={{ flex: 1000 - bar.permille }} />
              </View>
            )}
          </View>
        ))}
      </View>

      <View className="mt-6">
        <FilterPills
          label="Show payments by type"
          options={EXPENSE_FILTERS}
          value={filter}
          onChange={setFilter}
        />
      </View>

      <View className="mt-5">
        <SectionHeader
          title="Recent"
          action={filter === "company" ? "Company spending" : undefined}
          onAction={() => router.push("/spending")}
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="Nothing here"
            message={
              filter === "all"
                ? "No payments in this month yet."
                : "No payments of this type in the latest ones."
            }
          />
        ) : (
          <SoftGroup>
            {rows.map(({ key, ...row }) => (
              <ItemRow key={key} {...row} />
            ))}
          </SoftGroup>
        )}
      </View>

      {categories.length === 0 ? null : (
        <View className="mt-7">
          <SectionHeader title="By category" />
          <SoftGroup>
            {categories.map((category) => (
              <ItemRow
                key={category.id}
                title={category.name}
                amount={formatKesCents(category.currentKes)}
              />
            ))}
          </SoftGroup>
        </View>
      )}

      <View className="mt-6">
        <SoftGroup>
          <ItemRow
            title="Company spending"
            meta="Everything recorded by hand or paid outside Expendi"
            icon={Receipt}
            onPress={() => router.push("/spending")}
          />
          <ItemRow
            title="Paid-from accounts"
            meta="Bank accounts, cards and cash you pay from"
            icon={Landmark}
            onPress={() => router.push("/spending/accounts")}
          />
        </SoftGroup>
      </View>
    </>
  );
}

function ExpensesSkeleton(): JSX.Element {
  return (
    <View accessibilityLabel="Loading expenses" accessible>
      <View importantForAccessibility="no-hide-descendants" className="gap-3">
        <View className="h-5 w-32 rounded bg-gray-100" />
        <View className="h-12 w-56 rounded bg-gray-100" />
        <View className="h-4 w-48 rounded bg-gray-100" />
        <View className="mt-2 h-40 rounded-3xl bg-gray-50" />
      </View>
      <View className="mt-8">
        <SoftGroupSkeleton rows={3} label="Loading recent payments" />
      </View>
    </View>
  );
}
