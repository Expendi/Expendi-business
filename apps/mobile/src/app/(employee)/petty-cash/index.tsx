import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import type { FloatSummary } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { RequireCompany } from "~/features/claims/require-company";
import {
  FloatBalanceCard,
  FloatSpendingList,
  MovementRow,
} from "~/features/petty-cash/float-parts";
import { useFloat, useFloats } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function MyPettyCashRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <MyPettyCashScreen company={company} />}
    </RequireCompany>
  );
}

/** The caller's open float, or else the one they held most recently. */
function currentFloat(floats: readonly FloatSummary[]): FloatSummary | null {
  return floats.find((float) => float.status === "open") ?? floats[0] ?? null;
}

/**
 * The holder's petty cash (spec §6.22): what's left, "Paid from petty
 * cash", and what they've spent from it.
 */
function MyPettyCashScreen({ company }: { company: Company }): JSX.Element {
  const floats = useFloats(company.organizationId, { mine: true });

  if (floats.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading your float" />
      </Screen>
    );
  }
  if (floats.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(floats.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={floats.isFetching}
          onPress={() => void floats.refetch()}
        />
      </Screen>
    );
  }
  const float = currentFloat(floats.data.floats);
  if (!float) {
    return (
      <Screen belowHeader>
        <Text className="text-base text-gray-600">
          You don’t hold a petty cash float. When an admin issues you one, it’s
          paid to your M-Pesa and shows here.
        </Text>
      </Screen>
    );
  }
  return (
    <FloatScreen organizationId={company.organizationId} floatId={float.id} />
  );
}

function FloatScreen({
  organizationId,
  floatId,
}: {
  organizationId: string;
  floatId: string;
}): JSX.Element {
  const router = useRouter();
  const detail = useFloat(organizationId, floatId);

  if (detail.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading your float" />
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
  const payments = float.movements.filter(
    (movement) => movement.phase !== "awaiting_approval",
  );
  return (
    <Screen
      belowHeader
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <FloatBalanceCard float={float} />
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
        <Text className="text-base text-gray-600">
          This float is closed. Paid for something yourself? Submit a claim.
        </Text>
      )}
      <FloatSpendingList
        float={float}
        emptyText="Nothing recorded yet. Add each purchase as you make it."
      />
      {payments.length > 0 ? (
        <View className="gap-3">
          <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Money in and out
          </Text>
          {payments.map((movement) => (
            <MovementRow key={movement.id} movement={movement} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}
