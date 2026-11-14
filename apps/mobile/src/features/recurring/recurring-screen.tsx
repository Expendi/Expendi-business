import type { JSX } from "react";
import { useRouter } from "expo-router";
import { Repeat } from "lucide-react-native";
import { View } from "react-native";

import type { RecurringItem } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { LoadError } from "~/components/load-error";
import { Screen } from "~/components/screen";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import {
  nextBillCardDeclined,
  nextDueDate,
  payingCardLabel,
  recurringAmount,
  scheduleInWords,
  STATE_LABELS,
} from "./recurring-draft";
import { useRecurringItems } from "./use-recurring";

/** The recurring payments list, opened from Bills. */
export function RecurringScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const router = useRouter();
  const items = useRecurringItems(company.organizationId);
  const today = localIsoDate(new Date());

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
        <SoftGroupSkeleton label="Loading recurring payments" />
      ) : items.isError ? (
        <LoadError
          message={describeApiError(items.error)}
          retrying={items.isFetching}
          onRetry={() => void items.refetch()}
        />
      ) : items.data.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No recurring payments"
          message="Set up rent, subscriptions or a monthly KRA payment once, and its next bill is always ready in Bills."
        />
      ) : (
        <View>
          <SoftGroup>
            {items.data.map((item) => (
              <ItemRow
                key={item.id}
                title={item.payee.name}
                meta={recurringMeta(item, today)}
                metaTone={nextBillCardDeclined(item) ? "negative" : "default"}
                amount={recurringAmount(item, "Variable")}
                amountTone={item.state === "ended" ? "muted" : "default"}
                icon={Repeat}
                iconTone={item.state === "active" ? "brand" : "neutral"}
                onPress={() =>
                  router.push({
                    pathname: "/recurring/[itemId]",
                    params: { itemId: item.id },
                  })
                }
              />
            ))}
          </SoftGroup>
        </View>
      )}
    </Screen>
  );
}

function recurringMeta(item: RecurringItem, today: string): string {
  const schedule = scheduleInWords(item);
  const nextDue = nextDueDate(item);
  const next =
    item.state === "ended" && item.nextBill === null
      ? "No more bills"
      : nextDue === null
        ? null
        : `Next ${formatShortDate(nextDue, today)}`;
  const state = item.state === "active" ? null : STATE_LABELS[item.state].label;
  const declined = nextBillCardDeclined(item) ? "Card declined" : null;
  return [schedule, next, payingCardLabel(item), state, declined]
    .filter((part) => part !== null)
    .join(" · ");
}
