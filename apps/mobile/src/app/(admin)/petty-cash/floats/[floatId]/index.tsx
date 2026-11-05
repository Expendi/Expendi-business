import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import type { FloatMovement } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  holderName,
  movementAction,
} from "~/features/petty-cash/float-display";
import {
  FloatBalanceCard,
  FloatSpendingList,
  MovementRow,
} from "~/features/petty-cash/float-parts";
import { useFloat } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function FloatRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <FloatScreen company={company} />}
    </RequireAdmin>
  );
}

/**
 * One float, for an admin (spec §6.22): what was issued, spent and left,
 * its payments (approve one waiting, retry one that failed), its spending,
 * and top up, record a return or close.
 */
function FloatScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { floatId } = useLocalSearchParams<{ floatId: string }>();
  const detail = useFloat(company.organizationId, floatId);

  if (detail.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the float" />
      </Screen>
    );
  }
  if (detail.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(detail.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={detail.isFetching}
          onPress={() => void detail.refetch()}
        />
      </Screen>
    );
  }

  const float = detail.data;
  const open = float.status === "open";
  const goTo = (screen: "top-up" | "return" | "close"): void =>
    router.push({
      pathname: `/petty-cash/floats/[floatId]/${screen}`,
      params: { floatId },
    });
  const payAction = (movement: FloatMovement): JSX.Element | null => {
    const action = open ? movementAction(movement) : null;
    if (!action) return null;
    return (
      <Button
        label={action === "approve" ? "Approve & pay" : "Retry payment"}
        variant="secondary"
        onPress={() =>
          router.push({
            pathname: "/petty-cash/floats/[floatId]/pay",
            params: { floatId, movementId: movement.id },
          })
        }
      />
    );
  };

  return (
    <Screen
      belowHeader
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <Text
        accessibilityRole="header"
        className="text-2xl font-bold text-gray-900"
      >
        {holderName(float)}
      </Text>
      <FloatBalanceCard float={float} showHolder />
      {float.noReceiptCount > 0 ? (
        <Text className="text-sm font-semibold text-amber-800">
          {float.noReceiptCount === 1
            ? "1 purchase has no receipt."
            : `${float.noReceiptCount} purchases have no receipt.`}
        </Text>
      ) : null}

      {open ? (
        <View className="gap-3">
          <Button label="Top up" onPress={() => goTo("top-up")} />
          <Button
            label="Record cash handed back"
            variant="secondary"
            onPress={() => goTo("return")}
          />
          <Button
            label="Close the float"
            variant="secondary"
            onPress={() => goTo("close")}
          />
        </View>
      ) : null}

      <View className="gap-3">
        <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Money in and out
        </Text>
        {float.movements.map((movement) => (
          <MovementRow
            key={movement.id}
            movement={movement}
            action={payAction(movement)}
          />
        ))}
      </View>

      <FloatSpendingList float={float} emptyText="Nothing spent yet." />
    </Screen>
  );
}
