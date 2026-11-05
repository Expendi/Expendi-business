import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";

import type { FloatSummary } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { formatIsoDate, localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { holderName, kes } from "~/features/petty-cash/float-display";
import { useFloats } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function FloatsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <FloatsScreen company={company} />}
    </RequireAdmin>
  );
}

/** Every float: issued, spent, left, and spending without a receipt (spec §6.22). */
function FloatsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const floats = useFloats(company.organizationId, { mine: false });

  return (
    <Screen
      belowHeader
      refreshing={floats.isRefetching}
      onRefresh={() => void floats.refetch()}
    >
      <Button
        label="Issue a float"
        onPress={() => router.push("/petty-cash/floats/new")}
      />
      {floats.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading floats" />
      ) : floats.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(floats.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={floats.isFetching}
            onPress={() => void floats.refetch()}
          />
        </View>
      ) : floats.data.floats.length === 0 ? (
        <Text className="text-base text-gray-600">
          No floats yet. Issue one to pay someone petty cash ahead of spending
          it.
        </Text>
      ) : (
        <View className="gap-3">
          {floats.data.floats.map((float) => (
            <FloatRow
              key={float.id}
              float={float}
              onPress={() =>
                router.push({
                  pathname: "/petty-cash/floats/[floatId]",
                  params: { floatId: float.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function FloatRow({
  float,
  onPress,
}: {
  float: FloatSummary;
  onPress: () => void;
}): JSX.Element {
  const name = holderName(float);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${kes(float.leftKes)} left`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">{name}</Text>
          <Text className="text-sm text-gray-600">
            Issued {kes(float.issuedKes)} · Spent {kes(float.spentKes)}
          </Text>
          <Text className="text-sm text-gray-600">
            Opened {formatIsoDate(localIsoDate(new Date(float.openedAt)))}
          </Text>
        </View>
        <View className="items-end gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {kes(float.leftKes)}
          </Text>
          <Text className="text-sm text-gray-600">left</Text>
        </View>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Badge
          label={float.status === "open" ? "Open" : "Closed"}
          tone={float.status === "open" ? "success" : "neutral"}
        />
        {float.noReceiptCount > 0 ? (
          <Badge
            label={`${float.noReceiptCount} without a receipt`}
            tone="warning"
          />
        ) : null}
        {float.awaitingApprovalKes !== "0" ? (
          <Badge label="Payment waiting for approval" tone="warning" />
        ) : null}
        {float.onTheWayKes !== "0" ? (
          <Badge label="Payment on its way" />
        ) : null}
      </View>
    </Pressable>
  );
}
