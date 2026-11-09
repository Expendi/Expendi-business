import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import { useRouter } from "expo-router";
import { CreditCard } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import type { CardPurchaseList } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Section } from "~/components/section";
import { CardRow, PurchaseRow } from "~/features/cards/card-rows";
import { useMyCards, useReceiptsToAdd } from "~/features/cards/use-cards";
import { RequireCompany } from "~/features/claims/require-company";
import { describeApiError } from "~/lib/api";

export default function CardsRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <CardsScreen company={company} />}
    </RequireCompany>
  );
}

function CardsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const cards = useMyCards(company.organizationId);
  const receipts = useReceiptsToAdd(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={
        (cards.isRefetching || receipts.isRefetching) &&
        !receipts.isFetchingNextPage
      }
      onRefresh={() => {
        void cards.refetch();
        void receipts.refetch();
      }}
    >
      <ReceiptsToAdd receipts={receipts} />

      {cards.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading your cards" />
      ) : cards.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(cards.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={cards.isFetching}
            onPress={() => void cards.refetch()}
          />
        </View>
      ) : cards.data.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No cards yet"
          message="You don't hold an Expendi card. If you need one for work, ask an admin."
        />
      ) : (
        <View className="gap-2">
          {cards.data.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              onPress={() =>
                router.push({
                  pathname: "/cards/[cardId]",
                  params: { cardId: card.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function ReceiptsToAdd({
  receipts,
}: {
  receipts: UseInfiniteQueryResult<InfiniteData<CardPurchaseList>>;
}): JSX.Element | null {
  const router = useRouter();
  const items = receipts.data?.pages.flatMap((page) => page.purchases) ?? [];

  if (receipts.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(receipts.error)} />
        <Button
          label="Load receipts to add again"
          variant="secondary"
          loading={receipts.isFetching}
          onPress={() => void receipts.refetch()}
        />
      </View>
    );
  }
  if (items.length === 0) return null;

  return (
    <Section
      title="Receipts to add"
      description="Add these while you still have them."
    >
      <View className="gap-3">
        {items.map((purchase) => (
          <PurchaseRow
            key={purchase.id}
            purchase={purchase}
            onPress={() =>
              router.push({
                pathname: "/cards/purchases/[purchaseId]",
                params: { purchaseId: purchase.id, cardId: purchase.card.id },
              })
            }
          />
        ))}
        {receipts.hasNextPage ? (
          <Button
            label="Show more"
            variant="secondary"
            loading={receipts.isFetchingNextPage}
            onPress={() => void receipts.fetchNextPage()}
          />
        ) : null}
      </View>
    </Section>
  );
}
