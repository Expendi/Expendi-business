import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type {
  CompanySpending,
  OverviewHeading,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import type { ChipOption } from "~/features/payees/filter-chips";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { WarningBadges } from "~/features/claims/claim-warnings";
import { RequireAdmin } from "~/features/company/require-admin";
import { FilterChips } from "~/features/payees/filter-chips";
import {
  HEADING_LABELS,
  SPENDING_HEADINGS,
  spendingSummary,
} from "~/features/spending/spending-draft";
import { useCompanySpendingList } from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

const ALL = "all";

const HEADING_FILTERS: ChipOption<OverviewHeading | typeof ALL>[] = [
  { value: ALL, label: "All" },
  ...SPENDING_HEADINGS.map((heading) => ({
    value: heading,
    label: HEADING_LABELS[heading],
  })),
];

export default function CompanySpendingRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <CompanySpendingScreen company={company} />}
    </RequireAdmin>
  );
}

/** Money the company already spent outside Expendi (spec §6.23). */
function CompanySpendingScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const [heading, setHeading] = useState<OverviewHeading | typeof ALL>(ALL);
  const spending = useCompanySpendingList(
    company.organizationId,
    heading === ALL ? null : heading,
  );
  const items = spending.data?.pages.flatMap((page) => page.spending) ?? [];

  return (
    <Screen
      belowHeader
      refreshing={spending.isRefetching}
      onRefresh={() => void spending.refetch()}
    >
      <Button
        label="Record spending"
        onPress={() => router.push("/spending/new")}
      />
      <Button
        label="Paid-from accounts"
        variant="secondary"
        onPress={() => router.push("/spending/accounts")}
      />

      <FilterChips
        label="Heading"
        options={HEADING_FILTERS}
        value={heading}
        onChange={setHeading}
      />

      {spending.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading company spending" />
      ) : spending.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(spending.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={spending.isFetching}
            onPress={() => void spending.refetch()}
          />
        </View>
      ) : items.length === 0 ? (
        <Text className="text-base text-gray-600">
          {heading === ALL
            ? "Nothing recorded yet. Record a supplier paid from the bank, or a card payment, with its receipt. Bills marked paid outside Expendi show here too."
            : "Nothing recorded under this heading."}
        </Text>
      ) : (
        <View className="gap-3">
          {items.map((item) => (
            <SpendingRow
              key={item.id}
              spending={item}
              onPress={() =>
                router.push({
                  pathname: "/spending/[spendingId]",
                  params: { spendingId: item.id },
                })
              }
            />
          ))}
          {spending.hasNextPage ? (
            <Button
              label="Show more"
              variant="secondary"
              loading={spending.isFetchingNextPage}
              onPress={() => void spending.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function SpendingRow({
  spending,
  onPress,
}: {
  spending: CompanySpending;
  onPress: () => void;
}): JSX.Element {
  const amount = `KES ${formatKesCents(spending.amountKes)}`;
  const summary = spendingSummary(spending);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${spending.merchant}, ${amount}, ${summary}${spending.noReceipt ? ", no receipt" : ""}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {spending.merchant}
          </Text>
          <Text className="text-sm text-gray-600">{summary}</Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{amount}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Badge label={HEADING_LABELS[spending.overviewHeading]} />
        {spending.noReceipt ? (
          <Badge label="No receipt" tone="warning" />
        ) : null}
        {spending.bill ? <Badge label="From a bill" /> : null}
      </View>
      <WarningBadges warnings={spending.warnings} />
    </Pressable>
  );
}
