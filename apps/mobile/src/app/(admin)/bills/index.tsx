import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Bill } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import {
  groupOpenBills,
  historyNewestFirst,
} from "~/features/bills/bill-groups";
import { BillStatusBadge } from "~/features/bills/bill-status";
import { useBillHistory, useOpenBills } from "~/features/bills/use-bills";
import { formatIsoDate, localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function BillsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <BillsScreen company={company} />}
    </RequireAdmin>
  );
}

function BillsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const [today] = useState(() => localIsoDate(new Date()));
  const open = useOpenBills(company.organizationId);
  const history = useBillHistory(company.organizationId, today);
  const groups = groupOpenBills(open.data ?? []);
  const settled = historyNewestFirst(history.data ?? []);

  const openBill = (bill: Bill) =>
    router.push({ pathname: "/bills/[billId]", params: { billId: bill.id } });

  return (
    <Screen
      belowHeader
      refreshing={open.isRefetching || history.isRefetching}
      onRefresh={() => {
        void open.refetch();
        void history.refetch();
      }}
    >
      <Button label="New bill" onPress={() => router.push("/bills/new")} />
      <Button
        label="Recurring payments"
        variant="secondary"
        onPress={() => router.push("/recurring")}
      />

      {open.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading bills" />
      ) : open.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(open.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={open.isFetching}
            onPress={() => void open.refetch()}
          />
        </View>
      ) : groups.length === 0 ? (
        <Text className="text-base text-gray-600">
          Nothing to pay. Add a supplier invoice, rent or a KRA payment with its
          due date, and it shows here until it’s paid.
        </Text>
      ) : (
        groups.map((group) => (
          <View key={group.status} className="gap-3">
            <SectionTitle title={group.title} count={group.bills.length} />
            {group.bills.map((bill) => (
              <BillRow
                key={bill.id}
                bill={bill}
                onPress={() => openBill(bill)}
              />
            ))}
          </View>
        ))
      )}

      {settled.length > 0 ? (
        <View className="gap-3">
          <SectionTitle title="Paid and cancelled" count={settled.length} />
          {settled.map((bill) => (
            <BillRow key={bill.id} bill={bill} onPress={() => openBill(bill)} />
          ))}
        </View>
      ) : null}
      {history.isError ? (
        <ErrorMessage message={describeApiError(history.error)} />
      ) : null}
    </Screen>
  );
}

function SectionTitle({
  title,
  count,
}: {
  title: string;
  count: number;
}): JSX.Element {
  return (
    <Text
      accessibilityRole="header"
      className="text-sm font-semibold uppercase tracking-wide text-gray-500"
    >
      {title} · {count}
    </Text>
  );
}

function BillRow({
  bill,
  onPress,
}: {
  bill: Bill;
  onPress: () => void;
}): JSX.Element {
  const amount =
    bill.amountKes === null
      ? "Amount to enter"
      : `KES ${formatKesCents(bill.amountKes)}`;
  const when =
    bill.paidOn !== null
      ? `Paid ${formatIsoDate(bill.paidOn)}`
      : `Due ${formatIsoDate(bill.dueOn)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bill.payee.name}, ${amount}, ${when}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {bill.payee.name}
          </Text>
          <Text className="text-sm text-gray-600">
            {when}
            {bill.reference ? ` · ${bill.reference}` : ""}
          </Text>
        </View>
        <Text
          className={`text-base font-semibold ${bill.amountKes === null ? "text-amber-800" : "text-gray-900"}`}
        >
          {amount}
        </Text>
      </View>
      <BillStatusBadge status={bill.status} />
    </Pressable>
  );
}
