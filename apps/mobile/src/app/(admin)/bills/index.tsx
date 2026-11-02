import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Bill } from "@expendi-business/shared";
import { BILL_PAYMENT_MAX_BILLS } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { formatBillAmount } from "~/features/bills/bill-amount";
import {
  groupOpenBills,
  historyNewestFirst,
} from "~/features/bills/bill-groups";
import {
  isPayable,
  joinBillIds,
  toggleSelection,
} from "~/features/bills/bill-payment";
import { BillStatusBadge } from "~/features/bills/bill-status";
import { useBillHistory, useOpenBills } from "~/features/bills/use-bills";
import { formatIsoDate, localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";

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
  const anyPayable = (open.data ?? []).some(isPayable);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const openBill = (bill: Bill) =>
    router.push({ pathname: "/bills/[billId]", params: { billId: bill.id } });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };
  const pressBill = (bill: Bill) => {
    if (!selecting) {
      openBill(bill);
      return;
    }
    if (isPayable(bill)) setSelected((ids) => toggleSelection(ids, bill.id));
  };

  return (
    <Screen
      belowHeader
      refreshing={open.isRefetching || history.isRefetching}
      onRefresh={() => {
        void open.refetch();
        void history.refetch();
      }}
    >
      {selecting ? (
        <View className="gap-3 rounded-2xl border border-gray-200 p-4">
          <Text className="text-base text-gray-700">
            Tap the bills to pay together, up to {BILL_PAYMENT_MAX_BILLS}. One
            passkey confirmation pays them all.
          </Text>
          <Button
            label={
              selected.length === 0
                ? "Choose bills to pay"
                : `Pay ${selected.length} ${selected.length === 1 ? "bill" : "bills"}`
            }
            disabled={selected.length === 0}
            onPress={() => {
              router.push({
                pathname: "/bills/pay",
                params: { billIds: joinBillIds(selected) },
              });
              stopSelecting();
            }}
          />
          <Button label="Cancel" variant="ghost" onPress={stopSelecting} />
        </View>
      ) : (
        <>
          <Button label="New bill" onPress={() => router.push("/bills/new")} />
          {anyPayable ? (
            <Button
              label="Pay all"
              variant="secondary"
              onPress={() => setSelecting(true)}
            />
          ) : null}
          <Button
            label="Recurring payments"
            variant="secondary"
            onPress={() => router.push("/recurring")}
          />
        </>
      )}

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
                selection={
                  selecting && isPayable(bill)
                    ? selected.includes(bill.id)
                    : null
                }
                onPress={() => pressBill(bill)}
              />
            ))}
          </View>
        ))
      )}

      {settled.length > 0 ? (
        <View className="gap-3">
          <SectionTitle title="Paid and cancelled" count={settled.length} />
          {settled.map((bill) => (
            <BillRow
              key={bill.id}
              bill={bill}
              selection={null}
              onPress={() => openBill(bill)}
            />
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
  selection,
  onPress,
}: {
  bill: Bill;
  /** Whether it's chosen for Pay all; null when it can't be chosen. */
  selection: boolean | null;
  onPress: () => void;
}): JSX.Element {
  const formatted = formatBillAmount(bill);
  const amount = formatted ?? "Amount to enter";
  const when =
    bill.paidOn !== null
      ? `Paid ${formatIsoDate(bill.paidOn)}`
      : `Due ${formatIsoDate(bill.dueOn)}`;
  return (
    <Pressable
      accessibilityRole={selection === null ? "button" : "checkbox"}
      accessibilityState={
        selection === null ? undefined : { checked: selection }
      }
      accessibilityLabel={`${bill.payee.name}, ${amount}, ${when}`}
      onPress={onPress}
      className={`gap-2 rounded-xl border px-4 py-3 active:bg-gray-50 ${selection ? "border-gray-900 bg-gray-50" : "border-gray-200"}`}
    >
      <View className="flex-row items-start justify-between gap-3">
        {selection === null ? null : (
          <View
            className={`mt-0.5 h-6 w-6 items-center justify-center rounded border-2 ${selection ? "border-gray-900 bg-gray-900" : "border-gray-400"}`}
          >
            {selection ? <Text className="text-sm text-white">✓</Text> : null}
          </View>
        )}
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
          className={`text-base font-semibold ${formatted === null ? "text-amber-800" : "text-gray-900"}`}
        >
          {amount}
        </Text>
      </View>
      <BillStatusBadge status={bill.status} />
    </Pressable>
  );
}
