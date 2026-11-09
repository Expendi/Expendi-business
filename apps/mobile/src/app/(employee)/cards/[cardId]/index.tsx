import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Receipt } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { ExpendiCard } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { EmptyState } from "~/components/empty-state";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Section } from "~/components/section";
import { Text } from "~/components/text";
import {
  canFreeze,
  canShowDetails,
  cardStateNotice,
  maskedCardNumber,
  spentOfLimit,
} from "~/features/cards/card-display";
import { CardStateBadge, PurchaseRow } from "~/features/cards/card-rows";
import {
  useCardPurchases,
  useFreezeCard,
  useMyCard,
} from "~/features/cards/use-cards";
import { RequireCompany } from "~/features/claims/require-company";
import { describeApiError } from "~/lib/api";

export default function CardRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <CardScreen company={company} />}
    </RequireCompany>
  );
}

function CardScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { cardId } = useLocalSearchParams<{ cardId: string }>();
  const card = useMyCard(company.organizationId, cardId);

  if (card.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the card" />
      </Screen>
    );
  }
  if (card.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(card.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={card.isFetching}
          onPress={() => void card.refetch()}
        />
      </Screen>
    );
  }
  if (!card.data) {
    return (
      <Screen belowHeader>
        <ErrorMessage message="This card isn't available to you." />
        <Button
          label="Back to my cards"
          variant="secondary"
          onPress={() => router.replace("/cards")}
        />
      </Screen>
    );
  }

  return (
    <CardDetails
      organizationId={company.organizationId}
      card={card.data}
      refreshing={card.isRefetching}
      onRefresh={() => void card.refetch()}
    />
  );
}

function CardDetails({
  organizationId,
  card,
  refreshing,
  onRefresh,
}: {
  organizationId: string;
  card: ExpendiCard;
  refreshing: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const router = useRouter();
  const purchases = useCardPurchases(organizationId, card.id);
  const freeze = useFreezeCard(organizationId, card.id);
  const [confirmingFreeze, setConfirmingFreeze] = useState(false);
  const notice = cardStateNotice(card.state);
  const items = purchases.data?.pages.flatMap((page) => page.purchases) ?? [];

  return (
    <Screen
      belowHeader
      refreshing={
        (refreshing || purchases.isRefetching) && !purchases.isFetchingNextPage
      }
      onRefresh={() => {
        onRefresh();
        void purchases.refetch();
      }}
    >
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {card.nickname}
        </Text>
        <Text className="text-base text-gray-600">
          {maskedCardNumber(card.lastFour)}
        </Text>
        <CardStateBadge state={card.state} />
      </View>

      <Text className="text-base font-semibold text-gray-900">
        {spentOfLimit(card)}
      </Text>

      {notice ? (
        <Text className="rounded-xl border border-gray-200 bg-white p-3 text-sm leading-5 text-gray-700">
          {notice}
        </Text>
      ) : null}

      {canShowDetails(card) || canFreeze(card) ? (
        <View className="gap-3">
          {canShowDetails(card) ? (
            <Button
              label="Show card details"
              onPress={() =>
                router.push({
                  pathname: "/cards/[cardId]/reveal",
                  params: { cardId: card.id },
                })
              }
            />
          ) : null}
          {canFreeze(card) ? (
            <Button
              label="Freeze card"
              variant="secondary"
              onPress={() => {
                freeze.reset();
                setConfirmingFreeze(true);
              }}
            />
          ) : null}
        </View>
      ) : null}

      <Section title="Purchases">
        {purchases.isPending ? (
          <ActivityIndicator accessibilityLabel="Loading purchases" />
        ) : purchases.isError ? (
          <View className="gap-4">
            <ErrorMessage message={describeApiError(purchases.error)} />
            <Button
              label="Try again"
              variant="secondary"
              loading={purchases.isFetching}
              onPress={() => void purchases.refetch()}
            />
          </View>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No purchases yet"
            message="What you buy with this card shows up here straight away."
          />
        ) : (
          <View className="gap-3">
            {items.map((purchase) => (
              <PurchaseRow
                key={purchase.id}
                purchase={purchase}
                onPress={() =>
                  router.push({
                    pathname: "/cards/purchases/[purchaseId]",
                    params: { purchaseId: purchase.id, cardId: card.id },
                  })
                }
              />
            ))}
            {purchases.hasNextPage ? (
              <Button
                label="Show more"
                variant="secondary"
                loading={purchases.isFetchingNextPage}
                onPress={() => void purchases.fetchNextPage()}
              />
            ) : null}
          </View>
        )}
      </Section>

      <ConfirmSheet
        visible={confirmingFreeze}
        title="Freeze this card?"
        message={`Purchases on ${card.nickname} will be declined straight away. Only an admin can unfreeze it.`}
        confirmLabel="Freeze card"
        busy={freeze.isPending}
        error={freeze.isError ? describeApiError(freeze.error) : null}
        onConfirm={() =>
          freeze.mutate(undefined, {
            onSuccess: () => setConfirmingFreeze(false),
          })
        }
        onCancel={() => setConfirmingFreeze(false)}
      />
    </Screen>
  );
}
