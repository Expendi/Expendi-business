import type { JSX } from "react";
import { Stack, useRouter } from "expo-router";
import { Building2, Plus, Receipt } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import type { OverviewHeading } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { DetailHeader } from "~/components/detail-header";
import { EmptyState } from "~/components/empty-state";
import { FilterPills } from "~/components/filter-pills";
import { LoadError } from "~/components/load-error";
import { RoundButton } from "~/components/round-button";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  HEADING_LABELS,
  SPENDING_HEADINGS,
} from "~/features/spending/spending-draft";
import { spendingRowMeta } from "~/features/spending/spending-list";
import { useCompanySpendingList } from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { colors } from "~/theme/colors";

const ALL = "all";

const HEADING_FILTERS: { value: OverviewHeading | typeof ALL; label: string }[] =
  [
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
  const today = localIsoDate(new Date());

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen options={{ headerShown: false }} />
      <DetailHeader
        title="Company spending"
        onBack={() => router.back()}
        right={
          <RoundButton
            icon={Plus}
            label="Record spending"
            tone="brand"
            onPress={() => router.push("/spending/new")}
          />
        }
      />
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-3xl gap-5 px-5 pb-10 pt-4"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={spending.isRefetching}
            onRefresh={() => void spending.refetch()}
            tintColor={colors.brandStrong}
            colors={[colors.brandStrong]}
          />
        }
      >
        <FilterPills
          label="Heading"
          options={HEADING_FILTERS}
          value={heading}
          onChange={setHeading}
        />

        {spending.isPending ? (
          <SoftGroupSkeleton rows={4} label="Loading company spending" />
        ) : spending.isError ? (
          <LoadError
            message={describeApiError(spending.error)}
            retrying={spending.isFetching}
            onRetry={() => void spending.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={heading === ALL ? "Nothing recorded yet" : "Nothing under this heading"}
            message={
              heading === ALL
                ? "Record a supplier paid from the bank, or a card payment, with its receipt. Bills marked paid outside Expendi show here too."
                : "Try another heading, or record spending under this one."
            }
          />
        ) : (
          <>
            <SoftGroup>
              {items.map((item) => {
                const meta = spendingRowMeta(item, today);
                return (
                  <ItemRow
                    key={item.id}
                    title={item.merchant}
                    meta={meta.text}
                    metaTone={meta.needsAttention ? "negative" : "default"}
                    amount={formatKesCents(item.amountKes)}
                    icon={Building2}
                    iconTone={meta.needsAttention ? "negative" : "brand"}
                    onPress={() =>
                      router.push({
                        pathname: "/spending/[spendingId]",
                        params: { spendingId: item.id },
                      })
                    }
                  />
                );
              })}
            </SoftGroup>
            {spending.hasNextPage ? (
              <Button
                label="Show more"
                variant="secondary"
                loading={spending.isFetchingNextPage}
                onPress={() => void spending.fetchNextPage()}
              />
            ) : null}
          </>
        )}

        <Button
          label="Paid-from accounts"
          variant="secondary"
          onPress={() => router.push("/spending/accounts")}
        />
      </ScrollView>
    </View>
  );
}
