import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import type { CardPurchase } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import {
  declineNotice,
  maskedCardNumber,
  purchaseAmount,
  purchaseDate,
  purchaseKes,
  receiptSummary,
} from "~/features/cards/card-display";
import {
  purchaseAmountClass,
  PurchaseBadges,
} from "~/features/cards/card-rows";
import { useCardPurchase } from "~/features/cards/use-cards";
import { ReviewRow } from "~/features/claims/claim-editor";
import { RequireCompany } from "~/features/claims/require-company";
import { describeApiError } from "~/lib/api";

export default function CardPurchaseRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <CardPurchaseScreen company={company} />}
    </RequireCompany>
  );
}

function CardPurchaseScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { purchaseId } = useLocalSearchParams<{
    purchaseId: string;
  }>();
  const purchase = useCardPurchase(company.organizationId, purchaseId);

  if (purchase.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the purchase" />
      </Screen>
    );
  }
  if (purchase.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(purchase.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={purchase.isFetching}
          onPress={() => void purchase.refetch()}
        />
      </Screen>
    );
  }
  if (!purchase.data) {
    return (
      <Screen belowHeader>
        <ErrorMessage message="We couldn't find this purchase on your cards." />
        <Button
          label="Back to my cards"
          variant="secondary"
          onPress={() => router.replace("/cards")}
        />
      </Screen>
    );
  }

  const record = purchase.data;
  return (
    <Screen
      belowHeader
      refreshing={purchase.isRefetching}
      onRefresh={() => void purchase.refetch()}
    >
      <PurchaseSummary purchase={record} />
      {record.needsReceipt ? (
        <Button
          label="Add receipt"
          onPress={() =>
            router.push({
              pathname: "/cards/purchases/[purchaseId]/receipt",
              params: { purchaseId: record.id, cardId: record.card.id },
            })
          }
        />
      ) : null}
    </Screen>
  );
}

function PurchaseSummary({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element {
  const amount = purchaseAmount(purchase);
  const kes = purchaseKes(purchase);
  const decline = declineNotice(purchase);
  const receipts = receiptSummary(purchase);

  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {purchase.merchant}
        </Text>
        {amount ? (
          <Text
            className={`text-3xl font-bold ${purchaseAmountClass(purchase)}`}
          >
            {amount}
          </Text>
        ) : null}
        <PurchaseBadges purchase={purchase} />
      </View>

      {decline ? <ErrorMessage message={decline} /> : null}
      {purchase.kind === "refund" ? (
        <Text className="text-sm leading-5 text-gray-600">
          This money went back to the Card balance.
        </Text>
      ) : null}
      {purchase.changedAfterExpense ? (
        <Text className="text-sm leading-5 text-gray-600">
          This changed after it was recorded, and the books weren’t adjusted.
        </Text>
      ) : null}

      <View className="gap-4">
        <ReviewRow
          label="Card"
          value={`${purchase.card.nickname} ${maskedCardNumber(purchase.card.lastFour)}`}
        />
        <ReviewRow label="Date" value={purchaseDate(purchase.authorizedAt)} />
        {kes ? <ReviewRow label="Amount in KES" value={kes} /> : null}
        <ReviewRow label="Category" value={purchase.category.name} />
        {receipts ? <ReviewRow label="Receipt" value={receipts} /> : null}
      </View>
    </>
  );
}
