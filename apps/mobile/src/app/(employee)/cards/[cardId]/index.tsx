import type { LucideIcon } from "lucide-react-native";
import type { JSX, ReactNode } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  BedDouble,
  Car,
  CreditCard,
  Eye,
  Fuel,
  Plane,
  Receipt,
  Snowflake,
  Utensils,
} from "lucide-react-native";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import type { ExpendiCard } from "@expendi-business/shared";
import { formatUsdCents } from "@expendi-business/shared";

import type { QuickAction } from "~/components/quick-actions";
import type { Company } from "~/features/company/company-provider";
import type { MerchantKind } from "~/features/cards/card-display";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { DetailHeader } from "~/components/detail-header";
import { EmptyState } from "~/components/empty-state";
import { ErrorMessage } from "~/components/error-message";
import { LoadError } from "~/components/load-error";
import { QuickActions } from "~/components/quick-actions";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { Text } from "~/components/text";
import {
  canFreeze,
  canShowDetails,
  cardStateNotice,
  limitLeft,
  limitUsed,
  merchantKind,
  purchaseAmount,
  purchaseMeta,
  spentOfLimit,
} from "~/features/cards/card-display";
import { CardFace } from "~/features/cards/card-face";
import { CardStateBadge } from "~/features/cards/card-rows";
import {
  useCardPurchases,
  useFreezeCard,
  useMyCard,
} from "~/features/cards/use-cards";
import { RequireCompany } from "~/features/claims/require-company";
import { describeApiError } from "~/lib/api";
import { colors } from "~/theme/colors";

const MERCHANT_ICONS: Record<MerchantKind, LucideIcon> = {
  flight: Plane,
  stay: BedDouble,
  ride: Car,
  fuel: Fuel,
  food: Utensils,
  other: CreditCard,
};

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
      <CardShell>
        <SoftGroupSkeleton rows={3} label="Loading the card" />
      </CardShell>
    );
  }
  if (card.isError) {
    return (
      <CardShell>
        <LoadError
          message={describeApiError(card.error)}
          retrying={card.isFetching}
          onRetry={() => void card.refetch()}
        />
      </CardShell>
    );
  }
  if (!card.data) {
    return (
      <CardShell>
        <View className="gap-4">
          <ErrorMessage message="This card isn't available to you." />
          <Button
            label="Back to my cards"
            variant="secondary"
            onPress={() => router.replace("/cards")}
          />
        </View>
      </CardShell>
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

function CardShell({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const router = useRouter();
  return (
    <View className="flex-1 bg-white">
      <Stack.Screen options={{ headerShown: false }} />
      <DetailHeader title="Card" onBack={() => router.back()} />
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-3xl gap-6 px-5 pb-10 pt-4"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.brandStrong}
              colors={[colors.brandStrong]}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
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
  const today = new Date();

  const actions: QuickAction[] = [];
  if (canFreeze(card)) {
    actions.push({
      label: "Freeze",
      icon: Snowflake,
      onPress: () => {
        freeze.reset();
        setConfirmingFreeze(true);
      },
    });
  }
  if (canShowDetails(card)) {
    actions.push({
      label: "Show details",
      icon: Eye,
      onPress: () =>
        router.push({
          pathname: "/cards/[cardId]/reveal",
          params: { cardId: card.id },
        }),
    });
  }

  return (
    <CardShell
      refreshing={
        (refreshing || purchases.isRefetching) && !purchases.isFetchingNextPage
      }
      onRefresh={() => {
        onRefresh();
        void purchases.refetch();
      }}
    >
      <View className="gap-4">
        <CardFace card={card} />
        <View className="flex-row items-center justify-center gap-2">
          <Text
            accessibilityRole="header"
            className="text-[17px] font-semibold text-gray-900"
          >
            {card.nickname}
          </Text>
          <CardStateBadge state={card.state} />
        </View>
      </View>

      {actions.length > 0 ? <QuickActions actions={actions} /> : null}

      {notice ? (
        <Text className="rounded-3xl bg-gray-50 p-4 text-[15px] leading-5 text-gray-700">
          {notice}
        </Text>
      ) : null}

      <LimitMeter card={card} />

      <View>
        <SectionHeader title="Purchases" />
        {purchases.isPending ? (
          <SoftGroupSkeleton rows={3} label="Loading purchases" />
        ) : purchases.isError ? (
          <LoadError
            message={describeApiError(purchases.error)}
            retrying={purchases.isFetching}
            onRetry={() => void purchases.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No purchases yet"
            message="What you buy with this card shows up here straight away."
          />
        ) : (
          <View className="gap-3">
            <SoftGroup>
              {items.map((purchase) => (
                <ItemRow
                  key={purchase.id}
                  title={purchase.merchant}
                  meta={purchaseMeta(purchase, today)}
                  amount={purchaseAmount(purchase) ?? undefined}
                  amountTone={
                    purchase.status === "declined" ? "muted" : "default"
                  }
                  icon={MERCHANT_ICONS[merchantKind(purchase.mcc)]}
                  onPress={() =>
                    router.push({
                      pathname: "/cards/purchases/[purchaseId]",
                      params: { purchaseId: purchase.id, cardId: card.id },
                    })
                  }
                />
              ))}
            </SoftGroup>
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
      </View>

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
    </CardShell>
  );
}

/** This month's spend against the card's limit, as a coral meter. */
function LimitMeter({ card }: { card: ExpendiCard }): JSX.Element {
  const used = limitUsed(card);
  return (
    <View
      accessible
      accessibilityLabel={`${spentOfLimit(card)}. ${limitLeft(card)}.`}
      className="gap-3 rounded-3xl bg-gray-50 p-4"
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-[15px] font-medium text-gray-600">
          Monthly limit
        </Text>
        <Text
          className="text-[17px] font-semibold text-gray-900"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatUsdCents(BigInt(card.monthlyLimitUsdCents))}
        </Text>
      </View>
      <View className="h-2.5 overflow-hidden rounded-full bg-gray-200">
        <View
          className="h-full rounded-full bg-brand-500"
          style={{ width: `${Math.round(used * 1000) / 10}%` }}
        />
      </View>
      <View className="flex-row justify-between gap-3">
        <Text className="text-[14px] text-gray-600">
          {`${formatUsdCents(BigInt(card.spentThisMonthUsdCents))} spent`}
        </Text>
        <Text className="text-[14px] font-medium text-gray-900">
          {limitLeft(card)}
        </Text>
      </View>
    </View>
  );
}
