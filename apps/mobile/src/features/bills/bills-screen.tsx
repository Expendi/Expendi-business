import type { JSX } from "react";
import { useRouter } from "expo-router";
import {
  Check,
  CircleCheckBig,
  FileText,
  History,
  ListChecks,
  Plus,
  Repeat,
  Send,
} from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import type { Bill } from "@expendi-business/shared";
import { BILL_PAYMENT_MAX_BILLS } from "@expendi-business/shared";

import type { BillsView } from "./bills-list";
import type { ItemRowProps } from "~/components/soft-group";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { FilterPills } from "~/components/filter-pills";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { PillButton } from "~/components/pill-button";
import { RoundButton } from "~/components/round-button";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { Text } from "~/components/text";
import { TrendLine } from "~/components/trend-line";
import { maskedCardNumber } from "~/features/cards/card-display";
import { localIsoDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { colors } from "~/theme/colors";
import {
  automaticCard,
  cardDeclined,
  cardPaymentStop,
  formatEstimate,
  payingCard,
} from "./bill-card";
import { historyNewestFirst } from "./bill-groups";
import { isPayable, joinBillIds, toggleSelection } from "./bill-payment";
import {
  beingPaidBills,
  billWhen,
  overdueSummary,
  rowAmount,
  toPayBills,
  toPaySections,
  toPayTotal,
  totalExclusionNote,
  withoutPayrollBills,
} from "./bills-list";
import { useBillHistory, useOpenBills } from "./use-bills";

/** The Bills tab (direction K1): what the company owes, in flight, and settled. */
export function BillsScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const [today] = useState(() => localIsoDate(new Date()));
  const open = useOpenBills(company.organizationId);
  const history = useBillHistory(company.organizationId, today);
  const [view, setView] = useState<BillsView>("to-pay");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const openBills = withoutPayrollBills(open.data ?? []);
  const toPay = toPayBills(openBills);
  const beingPaid = beingPaidBills(openBills);
  const settled = historyNewestFirst(withoutPayrollBills(history.data ?? []));
  const anyPayable = toPay.some(isPayable);
  const total = toPayTotal(toPay);
  const exclusion = totalExclusionNote(total);
  const overdue = overdueSummary(toPay);

  const stopSelecting = (): void => {
    setSelecting(false);
    setSelected([]);
  };
  const changeView = (next: BillsView): void => {
    stopSelecting();
    setView(next);
  };
  const openBill = (bill: Bill): void =>
    router.push({ pathname: "/bills/[billId]", params: { billId: bill.id } });

  const rowFor = (
    bill: Bill,
    muted = false,
  ): ItemRowProps & { key: string } => {
    const when = billWhen(bill, today);
    const card = automaticCard(bill);
    const amount = card ? formatEstimate(bill) : rowAmount(bill);
    const paying = payingCard(bill);
    const stop = cardPaymentStop(bill);
    const declined = cardDeclined(bill);
    const cardNote = paying
      ? `Automatic · card ${maskedCardNumber(paying.lastFour)}`
      : (stop ?? (declined ? "Card declined" : null));
    const failed = bill.status === "payout_failed" || declined || stop !== null;
    const choosing = selecting && view === "to-pay";
    const payable = isPayable(bill);
    const checked = selected.includes(bill.id);
    return {
      key: bill.id,
      title: bill.payee.name,
      meta: cardNote === null ? when.text : `${when.text} · ${cardNote}`,
      metaTone:
        when.negative || (cardNote !== null && paying === null)
          ? "negative"
          : "default",
      amount: amount ?? "Add amount",
      amountTone: amount === null ? "action" : muted ? "muted" : "default",
      icon: bill.recurringItemId === null ? FileText : Repeat,
      iconTone:
        bill.status === "overdue" || failed
          ? "negative"
          : muted
            ? "neutral"
            : "brand",
      leading: choosing && payable ? <Checkbox checked={checked} /> : undefined,
      accessibilityRole: choosing && payable ? "checkbox" : "button",
      accessibilityState: choosing && payable ? { checked } : undefined,
      onPress: choosing
        ? payable
          ? () => setSelected((ids) => toggleSelection(ids, bill.id))
          : undefined
        : () => openBill(bill),
    };
  };

  const renderGroup = (bills: Bill[], muted = false): JSX.Element => (
    <SoftGroup>
      {bills.map((bill) => {
        const { key, ...row } = rowFor(bill, muted);
        const unavailable = selecting && view === "to-pay" && !isPayable(bill);
        return unavailable ? (
          <View key={key} className="opacity-50">
            <ItemRow {...row} />
          </View>
        ) : (
          <ItemRow key={key} {...row} />
        );
      })}
    </SoftGroup>
  );

  const refresh = (): void => {
    void open.refetch();
    void history.refetch();
  };

  const body = ((): JSX.Element => {
    if (view === "history") {
      if (history.isPending)
        return <SoftGroupSkeleton label="Loading history" />;
      if (history.isError) {
        return (
          <LoadError
            message={describeApiError(history.error)}
            retrying={history.isFetching}
            retryLabel="Try history again"
            onRetry={() => void history.refetch()}
          />
        );
      }
      return settled.length === 0 ? (
        <EmptyState
          icon={History}
          title="No paid bills yet"
          message="Bills you pay or cancel in the last six months show here."
        />
      ) : (
        renderGroup(settled, true)
      );
    }
    if (open.isPending) return <SoftGroupSkeleton label="Loading bills" />;
    if (open.isError) {
      return (
        <LoadError
          message={describeApiError(open.error)}
          retrying={open.isFetching}
          retryLabel="Try bills again"
          onRetry={() => void open.refetch()}
        />
      );
    }
    if (view === "paying") {
      return beingPaid.length === 0 ? (
        <EmptyState
          icon={Send}
          title="Nothing is being paid"
          message="Bills you pay through Expendi show here until the money lands."
        />
      ) : (
        renderGroup(beingPaid)
      );
    }
    const sections = toPaySections(toPay, today);
    if (sections.length === 0) {
      return (
        <EmptyState
          icon={CircleCheckBig}
          title="Nothing to pay"
          message="Add a supplier invoice, rent or a KRA payment with its due date, and it shows here until it's paid."
        />
      );
    }
    return (
      <View className="gap-6">
        {sections.map((section) => (
          <View key={section.key}>
            <SectionHeader title={section.title} />
            {renderGroup(section.bills)}
          </View>
        ))}
      </View>
    );
  })();

  return (
    <View className="flex-1 bg-white">
      <TabScreen
        title="Bills"
        right={
          <>
            <PillButton
              icon={Repeat}
              label="Recurring"
              accessibilityLabel="Recurring payments"
              onPress={() => router.push("/recurring")}
            />
            <RoundButton
              icon={Plus}
              label="New bill"
              tone="brand"
              onPress={() => router.push("/bills/new")}
            />
          </>
        }
        refreshing={open.isRefetching || history.isRefetching}
        onRefresh={refresh}
      >
        {open.isSuccess ? (
          <>
            <Text className="text-[16px] font-medium text-gray-600">
              To pay
            </Text>
            <View className="mt-2">
              <MoneyFigure code="KES" value={formatKesCents(total.kesCents)} />
            </View>
            {exclusion === null ? null : (
              <Text className="mt-1 text-[14px] leading-5 text-gray-600">
                {exclusion}
              </Text>
            )}
            {overdue === null ? null : (
              <TrendLine direction="out" text={overdue} />
            )}
          </>
        ) : null}

        <View className="mt-5">
          <FilterPills<BillsView>
            label="Bills"
            value={view}
            onChange={changeView}
            options={[
              {
                value: "to-pay",
                label: "To pay",
                count: open.isSuccess ? toPay.length : undefined,
              },
              {
                value: "paying",
                label: "Being paid",
                count: open.isSuccess ? beingPaid.length : undefined,
              },
              { value: "history", label: "History" },
            ]}
          />
        </View>

        {view === "to-pay" && open.isSuccess && anyPayable ? (
          <View className="mt-4 items-start gap-3">
            {selecting ? (
              <Text className="text-[14px] leading-5 text-gray-600">
                Tap the bills to pay together, up to {BILL_PAYMENT_MAX_BILLS}.
                One passkey confirmation pays them all.
              </Text>
            ) : (
              <PillButton
                icon={ListChecks}
                label="Select"
                accessibilityLabel="Select bills to pay together"
                onPress={() => setSelecting(true)}
              />
            )}
          </View>
        ) : null}

        <View className="mt-5">{body}</View>
      </TabScreen>

      {selecting && view === "to-pay" ? (
        <View className="flex-row gap-3 border-t border-gray-100 bg-white px-5 py-3">
          <View className="flex-1">
            <Button
              label="Cancel"
              variant="secondary"
              onPress={stopSelecting}
            />
          </View>
          <View className="flex-[2]">
            <Button
              label={
                selected.length === 0
                  ? "Choose bills to pay"
                  : `Pay ${String(selected.length)} ${selected.length === 1 ? "bill" : "bills"}`
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
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <View
      accessible={false}
      className={`h-7 w-7 items-center justify-center rounded-lg border-2 ${checked ? "border-brand-500 bg-brand-500" : "border-gray-300 bg-white"}`}
    >
      {checked ? <Check size={16} strokeWidth={3} color={colors.text} /> : null}
    </View>
  );
}
