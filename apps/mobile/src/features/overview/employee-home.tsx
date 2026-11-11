import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Banknote,
  Camera,
  CircleCheckBig,
  Ellipsis,
  Eye,
  EyeOff,
  MessageSquareText,
  QrCode,
  ReceiptText,
  Wallet,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import type { Claim, MeResponse } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { CoralHeader } from "~/components/coral-header";
import { CoralScreen } from "~/components/coral-screen";
import { EmptyState } from "~/components/empty-state";
import { GradientCard, WhiteMark, WhitePill } from "~/components/gradient-card";
import { LoadError } from "~/components/load-error";
import { MoneyFigure } from "~/components/money-figure";
import { QuickActions } from "~/components/quick-actions";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup, SoftGroupSkeleton } from "~/components/soft-group";
import { Text } from "~/components/text";
import { TrendLine } from "~/components/trend-line";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import {
  latestPayment,
  OWED_STATUSES,
  owedTotalCents,
  RETURNED_STATUSES,
} from "~/features/claims/owed";
import { reimbursementRow } from "~/features/claims/reimbursement-row";
import {
  useClaimList,
  useClaimsByStatus,
} from "~/features/claims/use-claims";
import { useMySalaryPayments } from "~/features/payroll/use-payroll";
import { useFloats } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";
import { colors } from "~/theme/colors";
import { useHideBalances } from "./hide-balances";
import { openFloatLeft } from "./overview-display";

const RECENT_LIMIT = 4;

/** The employee's (and accountant's) Home: what they're owed, what needs them, what's recent. */
export function EmployeeHome({
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
  const orgId = company.organizationId;
  const owed = useClaimsByStatus(orgId, OWED_STATUSES, { allPages: true });
  const returned = useClaimsByStatus(orgId, RETURNED_STATUSES, {
    allPages: true,
  });
  const paid = useClaimsByStatus(orgId, ["paid"], { allPages: false });
  const recent = useClaimList(orgId);
  const floats = useFloats(orgId, { mine: true });
  const salary = useMySalaryPayments(orgId);
  const { hidden, toggle: toggleHidden } = useHideBalances();
  const [refreshing, setRefreshing] = useState(false);
  const { refetch: refetchOwed } = owed;
  const { refetch: refetchReturned } = returned;
  const { refetch: refetchPaid } = paid;
  const { refetch: refetchRecent } = recent;
  const { refetch: refetchFloats } = floats;
  const { refetch: refetchSalary } = salary;
  useFocusEffect(
    useCallback(() => {
      void refetchOwed();
      void refetchReturned();
      void refetchPaid();
      void refetchRecent();
      void refetchFloats();
      void refetchSalary();
    }, [
      refetchOwed,
      refetchReturned,
      refetchPaid,
      refetchRecent,
      refetchFloats,
      refetchSalary,
    ]),
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["organizations", orgId] });
    } finally {
      setRefreshing(false);
    }
  }

  const returnedCount = returned.data?.claims.length ?? 0;
  const openFloats =
    floats.data?.floats.filter((row) => row.status === "open") ?? [];
  const floatLabel =
    openFloats.length > 0
      ? `Float · ${hidden ? "••••" : formatKesCents(openFloatLeft(openFloats))} left`
      : "Petty cash";

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
                : "Opens your profile"
            }
            onCompany={() =>
              canSwitchCompany
                ? router.push("/select-company")
                : router.navigate("/me/profile")
            }
            bellLabel={
              returnedCount === 0
                ? "Reimbursements"
                : `Reimbursements, ${String(returnedCount)} need you`
            }
            bellDot={returnedCount > 0}
            onBell={() => router.push("/claims")}
          />
          <View className="mx-1 mt-5">
            <GradientCard
              peek
              height={124}
              accessibilityLabel={floatLabel}
              onPress={() => router.navigate("/me/petty-cash")}
            >
              <View className="flex-row items-start justify-between px-4 pb-[68px] pt-4">
                <WhitePill
                  icon={openFloats.length > 0 ? Banknote : Wallet}
                  label={floatLabel}
                />
                <WhiteMark />
              </View>
            </GradientCard>
          </View>
        </>
      }
    >
      {owed.isPending ? (
        <HomeSkeleton />
      ) : owed.isError ? (
        <LoadError
          message={describeApiError(owed.error)}
          retryLabel="Try home again"
          retrying={owed.isFetching}
          onRetry={() => void owed.refetch()}
        />
      ) : (
        <>
          <OwedFigure
            claims={owed.data.claims}
            complete={owed.data.complete}
            paidClaims={paid.data?.claims ?? []}
            salary={salary.data ?? []}
            hidden={hidden}
            onToggleHidden={toggleHidden}
          />
          <View className="mt-6">
            <QuickActions
              actions={[
                {
                  label: "Add receipt",
                  icon: Camera,
                  onPress: () =>
                    router.push({
                      pathname: "/claims/new",
                      params: { evidence: "receipt" },
                    }),
                },
                {
                  label: "Paste SMS",
                  icon: MessageSquareText,
                  onPress: () =>
                    router.push({
                      pathname: "/claims/new",
                      params: { evidence: "sms" },
                    }),
                },
                {
                  label: "Scan eTIMS",
                  icon: QrCode,
                  onPress: () =>
                    router.push({
                      pathname: "/claims/new",
                      params: { evidence: "etims" },
                    }),
                },
                {
                  label: "More",
                  icon: Ellipsis,
                  onPress: () => router.navigate("/me/profile"),
                },
              ]}
            />
          </View>
          <NeedsYou returned={returned} />
          <Recent recent={recent} />
        </>
      )}
    </CoralScreen>
  );
}

function OwedFigure({
  claims,
  complete,
  paidClaims,
  salary,
  hidden,
  onToggleHidden,
}: {
  claims: readonly Claim[];
  complete: boolean;
  paidClaims: readonly Claim[];
  salary: Parameters<typeof latestPayment>[1];
  hidden: boolean;
  onToggleHidden: () => void;
}): JSX.Element {
  const today = localIsoDate(new Date());
  const total = owedTotalCents(claims);
  const payment = latestPayment(paidClaims, salary);
  const paidOn = payment ? formatShortDate(payment.day, today) : null;
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
            {complete ? "Owed to you" : "Owed to you, at least"}
          </Text>
          {hidden ? (
            <EyeOff size={18} strokeWidth={1.75} color={colors.muted} />
          ) : (
            <Eye size={18} strokeWidth={1.75} color={colors.muted} />
          )}
        </Pressable>
      </View>
      <View className="mt-2">
        <MoneyFigure code="KES" value={formatKesCents(total)} hidden={hidden} />
      </View>
      {payment && paidOn ? (
        <TrendLine
          direction="in"
          text={
            hidden
              ? `Paid to you on ${paidOn}`
              : `${formatKesCents(payment.amountKes)} paid to you on ${paidOn}`
          }
        />
      ) : BigInt(total) === 0n ? (
        <Text className="mt-1 text-[15px] leading-5 text-gray-600">
          Nothing is owed to you right now.
        </Text>
      ) : null}
    </>
  );
}

function NeedsYou({
  returned,
}: {
  returned: ReturnType<typeof useClaimsByStatus>;
}): JSX.Element {
  const router = useRouter();
  const today = localIsoDate(new Date());
  const rows = returned.data?.claims ?? [];
  return (
    <View className="mt-8">
      <SectionHeader
        title="Needs you"
        count={rows.length === 0 ? undefined : rows.length}
      />
      {returned.isPending ? (
        <SoftGroupSkeleton rows={1} label="Loading what needs you" />
      ) : returned.isError ? (
        <LoadError
          message={describeApiError(returned.error)}
          retryLabel="Try again"
          retrying={returned.isFetching}
          onRetry={() => void returned.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CircleCheckBig}
          title="You're all caught up"
          message="No reimbursements have been sent back to you."
        />
      ) : (
        <SoftGroup>
          {rows.map((claim) => (
            <ItemRow
              key={claim.id}
              {...reimbursementRow(claim, today, () =>
                router.push({
                  pathname: "/claims/[claimId]",
                  params: { claimId: claim.id },
                }),
              )}
            />
          ))}
        </SoftGroup>
      )}
    </View>
  );
}

function Recent({
  recent,
}: {
  recent: ReturnType<typeof useClaimList>;
}): JSX.Element {
  const router = useRouter();
  const today = localIsoDate(new Date());
  const rows = (recent.data?.pages[0]?.claims ?? [])
    .filter((claim) => claim.status !== "rejected")
    .slice(0, RECENT_LIMIT);
  return (
    <View className="mt-7">
      <SectionHeader
        title="Your reimbursements"
        action="See all"
        onAction={() => router.push("/claims")}
      />
      {recent.isPending ? (
        <SoftGroupSkeleton rows={3} label="Loading your reimbursements" />
      ) : recent.isError ? (
        <LoadError
          message={describeApiError(recent.error)}
          retryLabel="Try reimbursements again"
          retrying={recent.isFetching}
          onRetry={() => void recent.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No reimbursements yet"
          message="Add a receipt to get a work purchase paid back to M-Pesa."
        />
      ) : (
        <SoftGroup>
          {rows.map((claim) => (
            <ItemRow
              key={claim.id}
              {...reimbursementRow(claim, today, () =>
                router.push({
                  pathname: "/claims/[claimId]",
                  params: { claimId: claim.id },
                }),
              )}
            />
          ))}
        </SoftGroup>
      )}
    </View>
  );
}

function HomeSkeleton(): JSX.Element {
  return (
    <View accessibilityLabel="Loading your home" accessible>
      <View importantForAccessibility="no-hide-descendants" className="gap-3">
        <View className="h-5 w-24 rounded bg-gray-100" />
        <View className="h-12 w-56 rounded bg-gray-100" />
        <View className="h-4 w-40 rounded bg-gray-100" />
      </View>
      <View className="mt-8">
        <SoftGroupSkeleton rows={3} label="Loading your reimbursements" />
      </View>
    </View>
  );
}
