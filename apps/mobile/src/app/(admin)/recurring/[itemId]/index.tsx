import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import type { RecurringItem } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import type { RecurringItemAction } from "~/features/recurring/use-recurring";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { formatBillAmount } from "~/features/bills/bill-amount";
import { formatEstimate } from "~/features/bills/bill-card";
import { BillBadges, HEADING_LABELS } from "~/features/bills/bill-status";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  nextBillBadgeFields,
  nextBillCardDeclined,
  payViaInWords,
  recurringAmount,
  reminderInWords,
  scheduleInWords,
  STATE_LABELS,
} from "~/features/recurring/recurring-draft";
import {
  useRecurringItem,
  useRecurringItemAction,
} from "~/features/recurring/use-recurring";
import { describeApiError } from "~/lib/api";

export default function RecurringItemRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <RecurringItemScreen company={company} />}
    </RequireAdmin>
  );
}

function RecurringItemScreen({ company }: { company: Company }): JSX.Element {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const item = useRecurringItem(company.organizationId, itemId);

  if (item.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the recurring payment" />
      </Screen>
    );
  }
  if (item.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(item.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={item.isFetching}
          onPress={() => void item.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={item.isRefetching}
      onRefresh={() => void item.refetch()}
    >
      <ItemSummary item={item.data} />
      <NextBill item={item.data} />
      {item.data.state === "ended" ||
      item.data.overviewHeading === "salaries" ? null : (
        <ItemActions company={company} item={item.data} />
      )}
    </Screen>
  );
}

function ItemSummary({ item }: { item: RecurringItem }): JSX.Element {
  const state = STATE_LABELS[item.state];
  const heading =
    item.overviewHeading === "salaries"
      ? "Salaries & personnel"
      : HEADING_LABELS[item.overviewHeading];
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {item.payee.name}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          {recurringAmount(item, "Variable amount")}
        </Text>
        <Badge label={state.label} tone={state.tone} />
      </View>

      <View className="gap-4">
        <ReviewRow label="When" value={scheduleInWords(item)} />
        <ReviewRow label="Starts" value={formatIsoDate(item.startsOn)} />
        <ReviewRow
          label="Ends"
          value={item.endsOn ? formatIsoDate(item.endsOn) : "No end date"}
        />
        {item.nextDueOn ? (
          <ReviewRow
            label={item.nextBill ? "The bill after that" : "Next bill"}
            value={`Due ${formatIsoDate(item.nextDueOn)}`}
          />
        ) : null}
        <ReviewRow label="How it’s paid" value={payViaInWords(item)} />
        <ReviewRow label="Reminder" value={reminderInWords(item)} />
        <ReviewRow label="Overview heading" value={heading} />
        <ReviewRow label="Category" value={item.category.name} />
      </View>
    </>
  );
}

function NextBill({ item }: { item: RecurringItem }): JSX.Element | null {
  const router = useRouter();
  const bill = item.nextBill;
  const badgeFields = nextBillBadgeFields(item);
  if (bill === null || badgeFields === null) return null;
  const byCard = item.payVia === "card";
  const formatted = formatBillAmount({ ...bill, currency: item.currency });
  const amount = byCard
    ? formatEstimate({ ...bill, currency: item.currency })
    : (formatted ?? "Amount to enter");
  return (
    <View className="gap-3">
      <Text
        accessibilityRole="header"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Next bill
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          `Next bill, due ${formatIsoDate(bill.dueOn)}`,
          amount,
          ...(nextBillCardDeclined(item) ? ["card declined"] : []),
        ].join(", ")}
        onPress={() =>
          router.push({
            pathname: "/bills/[billId]",
            params: { billId: bill.id },
          })
        }
        className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
      >
        <View className="flex-row items-start justify-between gap-3">
          <Text className="flex-1 text-base font-semibold text-gray-900">
            Due {formatIsoDate(bill.dueOn)}
          </Text>
          <Text
            className={`text-base font-semibold ${formatted === null && !byCard ? "text-amber-800" : "text-gray-900"}`}
          >
            {amount}
          </Text>
        </View>
        <BillBadges bill={badgeFields} />
      </Pressable>
    </View>
  );
}

/**
 * Pausing or ending declines the payee's charges on a company-held card,
 * but doesn't cancel with the payee (spec §6.20).
 */
const CARD_CONSEQUENCES: Record<
  Exclude<RecurringItemAction, "resume">,
  (payee: string) => string
> = {
  pause: (payee) => `Card purchases from ${payee} are declined meanwhile.`,
  end: (payee) =>
    `Card purchases from ${payee} are declined from now on. Cancel with ${payee} too.`,
};

const CONFIRMATIONS: Record<
  Exclude<RecurringItemAction, "resume">,
  { title: string; message: (payee: string) => string; confirm: string }
> = {
  pause: {
    title: "Pause this payment?",
    message: (payee) =>
      `No new bills for ${payee} until you resume it. The bill already there stays.`,
    confirm: "Pause",
  },
  end: {
    title: "End this payment?",
    message: (payee) =>
      `No more bills for ${payee}. The bill already there stays. This can’t be undone.`,
    confirm: "End payment",
  },
};

function ItemActions({
  company,
  item,
}: {
  company: Company;
  item: RecurringItem;
}): JSX.Element {
  const router = useRouter();
  const action = useRecurringItemAction(company.organizationId, item.id);
  const [confirming, setConfirming] = useState<"pause" | "end" | null>(null);

  function close(): void {
    setConfirming(null);
    action.reset();
  }

  const confirmation = confirming ? CONFIRMATIONS[confirming] : null;
  const message =
    confirming === null
      ? ""
      : item.payVia === "card"
        ? `${CONFIRMATIONS[confirming].message(item.payee.name)} ${CARD_CONSEQUENCES[confirming](item.payee.name)}`
        : CONFIRMATIONS[confirming].message(item.payee.name);

  return (
    <View className="gap-3">
      <Button
        label="Edit payment"
        variant="secondary"
        onPress={() =>
          router.push({
            pathname: "/recurring/[itemId]/edit",
            params: { itemId: item.id },
          })
        }
      />
      {item.state === "paused" ? (
        <>
          <Button
            label="Resume"
            loading={action.isPending}
            onPress={() => action.mutate("resume")}
          />
          {action.isError && confirming === null ? (
            <ErrorMessage message={describeApiError(action.error)} />
          ) : null}
        </>
      ) : (
        <Button
          label="Pause"
          variant="secondary"
          onPress={() => setConfirming("pause")}
        />
      )}
      <Button
        label="End payment"
        variant="ghost"
        onPress={() => setConfirming("end")}
      />

      <ConfirmSheet
        visible={confirmation !== null}
        title={confirmation?.title ?? ""}
        message={message}
        confirmLabel={confirmation?.confirm ?? ""}
        dismissLabel="Keep it"
        busy={action.isPending}
        error={action.isError ? describeApiError(action.error) : null}
        onConfirm={() => {
          if (confirming) action.mutate(confirming, { onSuccess: close });
        }}
        onCancel={close}
      />
    </View>
  );
}
