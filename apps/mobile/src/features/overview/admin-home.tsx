import type { LucideIcon } from "lucide-react-native";
import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import {
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  Ellipsis,
  Eye,
  EyeOff,
  FileText,
  Plus,
  ReceiptText,
  Repeat,
  Users,
  Wallet,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import type {
  CashObligation,
  MeResponse,
  SpendingOverview,
} from "@expendi-business/shared";

import type { ItemRowProps } from "~/components/soft-group";
import type { Company } from "~/features/company/company-provider";
import { CoralHeader } from "~/components/coral-header";
import { CoralScreen } from "~/components/coral-screen";
import { EmptyState } from "~/components/empty-state";
import { GradientCard, WhiteMark, WhitePill } from "~/components/gradient-card";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { PillButton } from "~/components/pill-button";
import { QuickActions } from "~/components/quick-actions";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { Text } from "~/components/text";
import { TrendLine } from "~/components/trend-line";
import { formatDayMonth, formatShortDate } from "~/features/claims/dates";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatUsdc } from "~/lib/money";
import { colors } from "~/theme/colors";
import { useHideBalances } from "./hide-balances";
import {
  cashCardLine,
  cashExplanation,
  cashFigure,
  cashOutsideLine,
  obligationAmount,
  obligationPaidBy,
  obligationTarget,
} from "./overview-display";
import { useOverview } from "./use-overview";

const COMING_UP_LIMIT = 5;

/** The admin's Home (direction K1): cash first, then what needs them. */
export function AdminHome({
  me,
  company,
  canSwitchCompany,
}: {
  me: MeResponse;
  company: Company;
  canSwitchCompany: boolean;
}): JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const overview = useOverview(company.organizationId);
  const { hidden, toggle: toggleHidden } = useHideBalances();
  const [refreshing, setRefreshing] = useState(false);
  const { refetch } = overview;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", company.organizationId],
      });
    } finally {
      setRefreshing(false);
    }
  }

  const claimsWaiting = overview.data?.outstanding.claims.length ?? 0;
  const balanceUsdc = overview.data
    ? `${hidden ? "••••" : formatUsdc(overview.data.cash.balanceUsdc)} USDC`
    : "Wallet";

  return (
    <CoralScreen
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      top={
        <>
          <CoralHeader
            personName={me.user.fullName ?? me.user.email}
            company={company.name}
            companyHint={
              canSwitchCompany
                ? "Switches to another company"
                : "Opens the company tab"
            }
            onCompany={() =>
              canSwitchCompany
                ? router.push("/select-company")
                : router.navigate("/company")
            }
            bellLabel={
              claimsWaiting === 0
                ? "Reimbursements"
                : `Reimbursements, ${String(claimsWaiting)} waiting`
            }
            bellDot={claimsWaiting > 0}
            onBell={() => router.push("/approvals")}
          />
          <View className="mx-1 mt-5">
            <GradientCard
              peek
              height={124}
              accessibilityLabel={`Wallet, ${balanceUsdc}`}
              onPress={() => router.push("/wallet")}
            >
              <View className="flex-row items-start justify-between px-4 pb-[68px] pt-4">
                <WhitePill icon={Wallet} label={balanceUsdc} />
                <WhiteMark />
              </View>
            </GradientCard>
          </View>
        </>
      }
    >
      {overview.isPending ? (
        <HomeSkeleton />
      ) : overview.isError ? (
        <LoadError
          message={describeApiError(overview.error)}
          retryLabel="Try overview again"
          retrying={overview.isFetching}
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <HomeContent
          data={overview.data}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />
      )}
    </CoralScreen>
  );
}

function HomeContent({
  data,
  hidden,
  onToggleHidden,
}: {
  data: SpendingOverview;
  hidden: boolean;
  onToggleHidden: () => void;
}): JSX.Element {
  const router = useRouter();
  const [currency, setCurrency] = useState<"KES" | "USDC">("KES");
  const [explaining, setExplaining] = useState(false);
  const { cash, outstanding } = data;
  const figure = cashFigure(cash, currency);
  const canConvert = cash.status !== "unknown" && cash.rate !== null;
  const outsideLine = cashOutsideLine(cash);
  const cardLine = cashCardLine(cash);
  const due = formatDayMonth(cash.through);

  function openObligation(row: CashObligation): void {
    const target = obligationTarget(row);
    switch (target.screen) {
      case "bill":
        router.push({
          pathname: "/bills/[billId]",
          params: { billId: target.billId },
        });
        return;
      case "payroll_run":
        router.push({
          pathname: "/payroll/runs/[runId]",
          params: { runId: target.runId },
        });
        return;
      case "salaries":
        router.push("/payroll/salaries");
        return;
      case "recurring_item":
        router.push({
          pathname: "/recurring/[itemId]",
          params: { itemId: target.itemId },
        });
    }
  }

  const needs: (ItemRowProps & { key: string })[] = [
    ...outstanding.overdue.map((row) => ({
      ...obligationRow(row, cash.today, openObligation),
      meta: `Overdue · due ${formatShortDate(row.dueOn, cash.today)}`,
      metaTone: "negative" as const,
      iconTone: "negative" as const,
    })),
    ...outstanding.dueToday.map((row) => ({
      ...obligationRow(row, cash.today, openObligation),
      meta: ["Due today", payNote(row)]
        .filter((note) => note !== null)
        .join(" · "),
    })),
    ...(outstanding.claims.length === 0
      ? []
      : [
          {
            key: "claims",
            title: `${String(outstanding.claims.length)} ${outstanding.claims.length === 1 ? "reimbursement" : "reimbursements"}`,
            meta: outstanding.claims
              .map((row) => row.name.split(" ")[0] ?? row.name)
              .join(", "),
            amount: formatKesCents(
              outstanding.claims
                .reduce((sum, row) => sum + BigInt(row.amountKes), 0n)
                .toString(),
            ),
            icon: ReceiptText,
            onPress: () => router.push("/approvals"),
          },
        ]),
    ...outstanding.noReceipt.map((row) => ({
      key: `receipt:${row.id}`,
      title: row.name,
      meta: "Petty cash · no receipt",
      amount: formatKesCents(row.amountKes),
      icon: CircleAlert,
      onPress: () =>
        row.floatId
          ? router.push({
              pathname: "/petty-cash/floats/[floatId]",
              params: { floatId: row.floatId },
            })
          : router.push("/petty-cash/floats"),
    })),
  ];
  const comingUp = cash.obligations
    .filter((row) => row.dueOn > cash.today)
    .slice(0, COMING_UP_LIMIT)
    .map((row) => ({
      ...obligationRow(row, cash.today, openObligation),
      iconTone: "neutral" as const,
    }));

  return (
    <>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? "Show balances" : "Hide balances"}
          onPress={onToggleHidden}
          hitSlop={8}
          className="min-h-11 flex-row items-center gap-2"
        >
          <Text className="text-[16px] font-medium text-gray-600">
            {figure.label}
          </Text>
          {hidden ? (
            <EyeOff size={18} strokeWidth={1.75} color={colors.muted} />
          ) : (
            <Eye size={18} strokeWidth={1.75} color={colors.muted} />
          )}
        </Pressable>
        {canConvert ? (
          <PillButton
            label={currency}
            accessibilityLabel={
              currency === "KES" ? "Show in USDC" : "Show in KES"
            }
            onPress={() => setCurrency(currency === "KES" ? "USDC" : "KES")}
          />
        ) : null}
      </View>
      <View className="mt-2">
        <MoneyFigure code={figure.code} value={figure.value} hidden={hidden} />
      </View>
      {cash.status === "unknown" ? (
        <Text className="mt-1 text-[15px] leading-5 text-gray-600">
          Can&apos;t check what&apos;s due without today&apos;s KES rate.
        </Text>
      ) : BigInt(cash.totalKes) === 0n ? (
        <Text className="mt-1 text-[15px] leading-5 text-gray-600">
          Nothing to pay through Expendi by {due}.
        </Text>
      ) : (
        <TrendLine
          direction="out"
          text={
            hidden
              ? `Payments due by ${due}`
              : `${formatKesCents(cash.totalKes)} due by ${due}`
          }
          info
          accessibilityHint={
            explaining ? "Hides what's counted" : "Explains what's counted"
          }
          onPress={() => setExplaining(!explaining)}
        />
      )}
      {explaining ? (
        <View className="mt-2 gap-1 rounded-2xl bg-gray-50 p-4">
          <Text selectable className="text-[14px] leading-5 text-gray-700">
            {cashExplanation(cash)}
          </Text>
          {outsideLine === null ? null : (
            <Text selectable className="text-[14px] leading-5 text-gray-700">
              {outsideLine}
            </Text>
          )}
          {cardLine === null || cardLine.short ? null : (
            <Text selectable className="text-[14px] leading-5 text-gray-700">
              {cardLine.text}
            </Text>
          )}
        </View>
      ) : null}
      {cardLine?.short ? (
        <View className="mt-2 rounded-2xl bg-amber-50 p-4">
          <Text
            selectable
            accessibilityRole="alert"
            className="text-[14px] leading-5 text-amber-800"
          >
            {cardLine.text}
          </Text>
        </View>
      ) : null}

      <View className="mt-6">
        <QuickActions
          actions={[
            {
              label: "Approve",
              icon: CircleCheck,
              badge: outstanding.claims.length,
              onPress: () => router.push("/approvals"),
            },
            {
              label: "Pay a bill",
              icon: FileText,
              onPress: () => router.navigate("/bills"),
            },
            {
              label: "Add funds",
              icon: Plus,
              onPress: () => router.push("/wallet"),
            },
            {
              label: "More",
              icon: Ellipsis,
              onPress: () => router.navigate("/company"),
            },
          ]}
        />
      </View>

      <View className="mt-8">
        <SectionHeader
          title="Needs you"
          count={needs.length === 0 ? undefined : needs.length}
        />
        {needs.length === 0 ? (
          <EmptyState
            icon={CircleCheckBig}
            title="You're all caught up"
            message="No overdue bills, reimbursements or receipts to chase."
          />
        ) : (
          <SoftGroup>
            {needs.map(({ key, ...row }) => (
              <ItemRow key={key} {...row} />
            ))}
          </SoftGroup>
        )}
      </View>

      <View className="mt-7">
        <SectionHeader
          title="Coming up"
          action="See all"
          onAction={() => router.navigate("/bills")}
        />
        {comingUp.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="Nothing due"
            message={`No payments are due between now and ${due}.`}
          />
        ) : (
          <SoftGroup>
            {comingUp.map(({ key, ...row }) => (
              <ItemRow key={key} {...row} />
            ))}
          </SoftGroup>
        )}
      </View>
    </>
  );
}

const OBLIGATION_ICONS: Record<CashObligation["kind"], LucideIcon> = {
  bill: FileText,
  payroll: Users,
  forecast: Repeat,
};

/** A bill, payroll run or recurring payment as a row; callers adjust the meta. */
function obligationRow(
  row: CashObligation,
  today: string,
  onOpen: (row: CashObligation) => void,
): ItemRowProps & { key: string } {
  const notes = [
    formatShortDate(row.dueOn, today),
    row.kind === "forecast" ? "recurring" : null,
    payNote(row),
  ].filter((note) => note !== null);
  return {
    key: `${row.kind}:${row.id}:${row.dueOn}`,
    title: row.kind === "payroll" ? "Payroll" : row.name,
    meta: notes.join(" · "),
    ...(row.card
      ? { amount: obligationAmount(row) }
      : row.amountKes !== null
        ? { amount: formatKesCents(row.amountKes) }
        : row.needsAmount
          ? { amount: "Add amount", amountTone: "action" as const }
          : { amount: "Amount not in yet", amountTone: "muted" as const }),
    icon: OBLIGATION_ICONS[row.kind],
    onPress: () => onOpen(row),
  };
}

/** A company-held card's payment, or one paid outside Expendi; null otherwise. */
function payNote(row: CashObligation): string | null {
  if (row.card) return obligationPaidBy(row);
  return row.payVia === "outside" ? "pay outside Expendi" : null;
}

function HomeSkeleton(): JSX.Element {
  return (
    <View accessibilityLabel="Loading your overview" accessible>
      <View importantForAccessibility="no-hide-descendants" className="gap-3">
        <View className="h-5 w-24 rounded bg-gray-100" />
        <View className="h-12 w-56 rounded bg-gray-100" />
        <View className="h-4 w-40 rounded bg-gray-100" />
      </View>
      <View className="mt-8">
        <SoftGroupSkeleton rows={3} label="Loading what needs you" />
      </View>
    </View>
  );
}
