import type { JSX } from "react";
import { CreditCard } from "lucide-react-native";
import { Pressable, View } from "react-native";

import type { CardPurchase, ExpendiCard } from "@expendi-business/shared";

import { Badge } from "~/components/badge";
import { ListRow } from "~/components/list-row";
import { Text } from "~/components/text";
import {
  CARD_STATE_BADGES,
  maskedCardNumber,
  purchaseAmount,
  purchaseBadges,
  purchaseDate,
  spentOfLimit,
} from "./card-display";

export function CardStateBadge({
  state,
}: {
  state: ExpendiCard["state"];
}): JSX.Element {
  const { label, tone } = CARD_STATE_BADGES[state];
  return <Badge label={label} tone={tone} />;
}

export function CardRow({
  card,
  onPress,
}: {
  card: ExpendiCard;
  onPress: () => void;
}): JSX.Element {
  return (
    <ListRow
      title={card.nickname}
      subtitle={`${maskedCardNumber(card.lastFour)} · ${spentOfLimit(card)}`}
      icon={CreditCard}
      accessory={<CardStateBadge state={card.state} />}
      onPress={onPress}
    />
  );
}

export function PurchaseBadges({
  purchase,
}: {
  purchase: CardPurchase;
}): JSX.Element {
  return (
    <View className="flex-row flex-wrap gap-2">
      {purchaseBadges(purchase).map(({ label, tone }) => (
        <Badge key={label} label={label} tone={tone} />
      ))}
    </View>
  );
}

/** A refund is money coming back, so it doesn't read like a spend. */
export function purchaseAmountClass(purchase: CardPurchase): string {
  return purchase.kind === "refund" ? "text-green-800" : "text-gray-900";
}

export function PurchaseRow({
  purchase,
  onPress,
}: {
  purchase: CardPurchase;
  onPress: () => void;
}): JSX.Element {
  const amount = purchaseAmount(purchase);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        amount ? `${purchase.merchant}, ${amount}` : purchase.merchant
      }
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {purchase.merchant}
          </Text>
          <Text className="text-sm text-gray-600">
            {purchaseDate(purchase.authorizedAt)}
          </Text>
        </View>
        {amount ? (
          <Text
            className={`text-base font-semibold ${purchaseAmountClass(purchase)}`}
          >
            {amount}
          </Text>
        ) : null}
      </View>
      <PurchaseBadges purchase={purchase} />
    </Pressable>
  );
}
