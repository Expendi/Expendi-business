import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";

import type { RecurringItem } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { formatBillAmount } from "~/features/bills/bill-amount";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  nextDueDate,
  scheduleInWords,
  STATE_LABELS,
} from "~/features/recurring/recurring-draft";
import { useRecurringItems } from "~/features/recurring/use-recurring";
import { describeApiError } from "~/lib/api";

export default function RecurringItemsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <RecurringItemsScreen company={company} />}
    </RequireAdmin>
  );
}

function RecurringItemsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const items = useRecurringItems(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={items.isRefetching}
      onRefresh={() => void items.refetch()}
    >
      <Button
        label="New recurring payment"
        onPress={() => router.push("/recurring/new")}
      />

      {items.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading recurring payments" />
      ) : items.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(items.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={items.isFetching}
            onPress={() => void items.refetch()}
          />
        </View>
      ) : items.data.length === 0 ? (
        <Text className="text-base text-gray-600">
          Set up rent, subscriptions or a monthly KRA payment once, and its next
          bill is always ready in Bills.
        </Text>
      ) : (
        <View className="gap-3">
          {items.data.map((item) => (
            <RecurringRow
              key={item.id}
              item={item}
              onPress={() =>
                router.push({
                  pathname: "/recurring/[itemId]",
                  params: { itemId: item.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function RecurringRow({
  item,
  onPress,
}: {
  item: RecurringItem;
  onPress: () => void;
}): JSX.Element {
  const amount = formatBillAmount(item) ?? "Variable";
  const nextDue = nextDueDate(item);
  const when =
    item.state === "ended" && item.nextBill === null
      ? "No more bills"
      : nextDue === null
        ? scheduleInWords(item)
        : `Next due ${formatIsoDate(nextDue)}`;
  const state = STATE_LABELS[item.state];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.payee.name}, ${amount}, ${scheduleInWords(item)}, ${when}, ${state.label}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {item.payee.name}
          </Text>
          <Text className="text-sm text-gray-600">{scheduleInWords(item)}</Text>
          <Text className="text-sm text-gray-600">{when}</Text>
        </View>
        <Text
          className={`text-base font-semibold ${item.variable ? "text-amber-800" : "text-gray-900"}`}
        >
          {amount}
        </Text>
      </View>
      <Badge label={state.label} tone={state.tone} />
    </Pressable>
  );
}
