import type { JSX } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import type { WalletHistoryItem } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  describeCounterparty,
  formatSignedUsdc,
  PAYOUT_STATUS_LABELS,
  TRANSACTION_TYPES,
} from "~/features/wallet/history-display";
import { useWalletHistory } from "~/features/wallet/use-wallet-history";
import { describeApiError } from "~/lib/api";

export default function WalletHistoryRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <WalletHistoryScreen company={company} />}
    </RequireAdmin>
  );
}

function WalletHistoryScreen({ company }: { company: Company }): JSX.Element {
  const history = useWalletHistory(company.organizationId);
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Screen
      belowHeader
      refreshing={history.isRefetching && !history.isFetchingNextPage}
      onRefresh={() => void history.refetch()}
    >
      {history.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading the history" />
      ) : history.isError && items.length === 0 ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(history.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={history.isFetching}
            onPress={() => void history.refetch()}
          />
        </View>
      ) : items.length === 0 ? (
        <Text className="text-base text-gray-600">
          Nothing yet. Deposits, payments and withdrawals will show here.
        </Text>
      ) : (
        <View className="gap-3">
          {items.map((item) => (
            <HistoryRow key={item.id} item={item} />
          ))}
          <ErrorMessage
            message={
              history.isFetchNextPageError
                ? describeApiError(history.error)
                : null
            }
          />
          {history.hasNextPage ? (
            <Button
              label="Show older"
              variant="secondary"
              loading={history.isFetchingNextPage}
              onPress={() => void history.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function HistoryRow({ item }: { item: WalletHistoryItem }): JSX.Element {
  const type = TRANSACTION_TYPES[item.type];
  const counterparty = describeCounterparty(item);
  const status = item.payout ? PAYOUT_STATUS_LABELS[item.payout.status] : null;
  const isCredit = !item.usdcAmount.startsWith("-");
  const when = dateFormat.format(new Date(item.createdAt));

  return (
    <View
      accessible
      accessibilityLabel={[
        type.label,
        `${formatSignedUsdc(item.usdcAmount)} USDC`,
        counterparty,
        when,
        status?.label,
      ]
        .filter(Boolean)
        .join(", ")}
      className="flex-row items-center gap-3 rounded-xl border border-gray-200 px-4 py-3"
    >
      <View
        className={`h-10 w-10 items-center justify-center rounded-full ${isCredit ? "bg-green-50" : "bg-gray-100"}`}
      >
        <Text
          importantForAccessibility="no"
          className={`text-lg font-bold ${isCredit ? "text-green-800" : "text-gray-700"}`}
        >
          {type.icon}
        </Text>
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-semibold text-gray-900">
          {type.label}
        </Text>
        {counterparty ? (
          <Text numberOfLines={1} className="text-sm text-gray-600">
            {counterparty}
          </Text>
        ) : null}
        <Text className="text-xs text-gray-500">{when}</Text>
      </View>
      <View className="items-end gap-1">
        <Text
          className={`text-base font-semibold ${isCredit ? "text-green-800" : "text-gray-900"}`}
        >
          {formatSignedUsdc(item.usdcAmount)}
        </Text>
        {status ? <Badge label={status.label} tone={status.tone} /> : null}
      </View>
    </View>
  );
}
