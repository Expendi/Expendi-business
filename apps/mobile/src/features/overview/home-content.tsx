import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Banknote,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Receipt,
  Users,
  Wallet,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import type {
  CashObligation,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  overviewPersonSchema,
  paymentPollInterval,
  spendingOverviewSchema,
} from "@expendi-business/shared";

import { Button } from "~/components/button";
import { EmptyState } from "~/components/empty-state";
import { ErrorMessage } from "~/components/error-message";
import { ListRow } from "~/components/list-row";
import { OverviewSkeleton } from "~/components/overview-skeleton";
import { Section } from "~/components/section";
import { Text } from "~/components/text";
import { useClaimList } from "~/features/claims/use-claims";
import { useMySalaryPayments } from "~/features/payroll/use-payroll";
import { useFloats } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";
import { overviewPersonStatuses } from "~/lib/payment-poll";
import { useApi } from "~/providers/api-provider";
import { colors } from "~/theme/colors";
import {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  kes,
  obligationAction,
  obligationAmount,
  obligationTarget,
  openFloatLeft,
  shiftMonth,
} from "./overview-display";

function Note({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text selectable className="text-sm leading-5 text-gray-600">
      {children}
    </Text>
  );
}

export function AdminHomeContent({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const api = useApi();
  const router = useRouter();
  const [month, setMonth] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["organizations", organizationId, "overview", month],
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/overview${month ? `?month=${month}` : ""}`,
        spendingOverviewSchema,
      ),
  });
  const { refetch } = overview;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const person = useQuery({
    queryKey: ["organizations", organizationId, "overview-person", personId],
    enabled: personId !== null,
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/overview/people/${personId}`,
        overviewPersonSchema,
      ),
    refetchInterval: (query) =>
      paymentPollInterval(overviewPersonStatuses(query.state.data)),
  });
  if (overview.isPending) return <OverviewSkeleton />;
  if (overview.isError)
    return (
      <View className="gap-2">
        <ErrorMessage message={describeApiError(overview.error)} />
        <Button
          label="Try overview again"
          onPress={() => void overview.refetch()}
        />
      </View>
    );
  const data = overview.data;
  const outsideLine = cashOutsideLine(data.cash);
  function openObligation(row: CashObligation) {
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
  return (
    <View className="gap-7">
      <View className="gap-5 rounded-2xl border border-gray-200 bg-white p-5">
        <View className="flex-row items-center gap-2">
          <Wallet size={18} color={colors.brandStrong} accessible={false} />
          <Text className="text-sm font-medium text-gray-600">
            Company wallet
          </Text>
        </View>
        <View className="gap-1">
          <Text
            selectable
            className="text-3xl font-semibold leading-10 text-gray-900"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {formatUsdc(data.cash.balanceUsdc)} USDC
          </Text>
          <Text
            selectable
            className="text-base text-gray-600"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {data.cash.balanceKes === null
              ? "KES rate unavailable"
              : kes(data.cash.balanceKes)}
          </Text>
        </View>
        <View className="gap-2 rounded-xl bg-brand-50 p-4">
          <Text className="text-xs font-medium text-brand-800">
            Cash check · through {data.cash.through}
          </Text>
          <Text
            selectable
            className="text-lg font-semibold leading-6 text-gray-900"
          >
            {cashHeadline(data.cash)}
          </Text>
          <Text selectable className="text-sm leading-5 text-gray-700">
            Available after payments being made:{" "}
            {data.cash.availableKes === null
              ? "unavailable"
              : kes(data.cash.availableKes)}
          </Text>
        </View>
        {outsideLine === null ? null : <Note>{outsideLine}</Note>}
        <Note>{cashFootnote(data.cash)}</Note>
      </View>
      <Section title="Spending overview">
        <View className="flex-row items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white p-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            className="h-12 w-12 items-center justify-center rounded-lg active:bg-gray-100"
            onPress={() => setMonth(shiftMonth(data.month, -1))}
          >
            <ChevronLeft size={20} color={colors.text} accessible={false} />
          </Pressable>
          <Text
            accessibilityLiveRegion="polite"
            className="flex-1 text-center text-sm font-semibold text-gray-900"
          >
            {data.month}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            className="h-12 w-12 items-center justify-center rounded-lg active:bg-gray-100"
            onPress={() => setMonth(shiftMonth(data.month, 1))}
          >
            <ChevronRight size={20} color={colors.text} accessible={false} />
          </Pressable>
        </View>
        <Text
          selectable
          className="text-3xl font-semibold leading-10 text-gray-900"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {kes(data.currentKes)}
        </Text>
        <Note>
          {kes(data.previousKes)} in {data.previousMonth}. Month boundaries use
          Nairobi time.
        </Note>
        <Breakdown rows={data.headings} />
        <Text className="font-semibold text-gray-900">By category</Text>
        <Breakdown rows={data.categories} />
        {data.categories.length === 0 ? (
          <Note>No spending recorded in either month.</Note>
        ) : null}
      </Section>
      <Section title="Needs attention">
        <Note>
          {data.outstanding.overdue.length} overdue ·{" "}
          {data.outstanding.dueToday.length} due today
        </Note>
        {[...data.outstanding.overdue, ...data.outstanding.dueToday].map(
          (row) => (
            <ListRow
              key={`${row.kind}:${row.id}:${row.dueOn}`}
              title={row.name}
              subtitle={`${row.dueOn} · ${obligationAmount(row)}`}
              onPress={() => openObligation(row)}
            />
          ),
        )}
        <ListRow
          icon={CircleCheck}
          title={`${data.outstanding.claims.length} claims waiting for approval`}
          subtitle={kes(
            data.outstanding.claims
              .reduce((sum, row) => sum + BigInt(row.amountKes), 0n)
              .toString(),
          )}
          onPress={() => router.push("/approvals")}
        />
        <Note>
          {data.outstanding.noReceipt.length} petty cash purchases without a
          receipt
        </Note>
        {data.outstanding.noReceipt.map((row) => (
          <ListRow
            key={row.id}
            title={row.name}
            subtitle={kes(row.amountKes)}
            onPress={() =>
              row.floatId
                ? router.push({
                    pathname: "/petty-cash/floats/[floatId]",
                    params: { floatId: row.floatId },
                  })
                : router.push("/petty-cash/floats")
            }
          />
        ))}
      </Section>
      <Section title="Upcoming payments" description="Due in the next 30 days">
        {data.cash.obligations.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="Nothing due"
            message="No payments are due in the next 30 days."
          />
        ) : (
          data.cash.obligations.map((row) => (
            <View
              key={`${row.kind}:${row.id}:${row.dueOn}`}
              className="gap-3 rounded-xl border border-gray-200 bg-white p-4"
            >
              <View className="flex-row items-start justify-between gap-3">
                <Text className="flex-1 text-base font-medium text-gray-900">
                  {row.name}
                </Text>
                <Text
                  selectable
                  className="flex-1 text-right text-base font-semibold text-gray-900"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {obligationAmount(row)}
                </Text>
              </View>
              <Note>
                {row.dueOn} ·{" "}
                {row.kind === "forecast"
                  ? "not billed yet"
                  : row.status.replaceAll("_", " ")}{" "}
                ·{" "}
                {row.payVia === "outside"
                  ? "Paid outside Expendi"
                  : "Through Expendi"}
              </Note>
              <Button
                label={obligationAction(row)}
                variant="secondary"
                onPress={() => openObligation(row)}
              />
            </View>
          ))
        )}
      </Section>
      <Section title="Recent payments">
        {data.recentPayments.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No payments yet"
            message={`No payments in ${data.previousMonth} or ${data.month}.`}
          />
        ) : (
          data.recentPayments.map((row) => (
            <View key={row.id} className="gap-2 border-b border-gray-200 pb-3">
              <View className="flex-row items-start justify-between gap-3">
                <Text className="flex-1 text-base font-medium text-gray-900">
                  {row.name}
                </Text>
                <Text
                  selectable
                  className="flex-1 text-right text-base font-semibold text-gray-900"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {kes(row.amountKes)}
                </Text>
              </View>
              <Note>
                {row.date} ·{" "}
                {row.channel === "expendi"
                  ? "Through Expendi"
                  : row.channel === "outside"
                    ? "Paid outside"
                    : "Petty cash spending"}
              </Note>
            </View>
          ))
        )}
      </Section>
      <Section title="People">
        {data.people.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No spending by person"
            message="People will appear here when they have spending to review."
          />
        ) : null}
        {data.people.map((row) => (
          <ListRow
            key={row.id}
            title={row.name}
            icon={Users}
            onPress={() => setPersonId(row.id === personId ? null : row.id)}
          />
        ))}
        {personId !== null && person.isPending ? (
          <Note>Loading person…</Note>
        ) : null}
        {personId !== null && person.isError ? (
          <View>
            <Note>{describeApiError(person.error)}</Note>
            <Button
              label="Try person again"
              onPress={() => void person.refetch()}
            />
          </View>
        ) : null}
        {personId !== null && person.data ? (
          <View className="gap-3 rounded-xl border border-gray-200 bg-white p-4">
            <Text accessibilityRole="header" className="text-lg font-bold">
              {person.data.name}
            </Text>
            <Note>Salary</Note>
            {person.data.salaries.length === 0 ? (
              <Note>No salary set up.</Note>
            ) : (
              person.data.salaries.map((row) => (
                <Note key={row.id}>
                  {kes(row.amountKes)} · {row.active ? "Active" : "Ended"} ·{" "}
                  {row.nextDueOn ?? "No next date"}
                </Note>
              ))
            )}
            <Note>Float balance</Note>
            {person.data.floats.length === 0 ? (
              <Note>No floats.</Note>
            ) : (
              person.data.floats.map((row) => (
                <Note key={row.id}>
                  {kes(row.leftKes)} · {row.status}
                </Note>
              ))
            )}
            <Note>Claims</Note>
            {person.data.claims.length === 0 ? (
              <Note>No claims.</Note>
            ) : (
              person.data.claims.map((row) => (
                <Note key={row.id}>
                  {row.name} · {kes(row.amountKes)} · {row.status}
                </Note>
              ))
            )}
            <Note>Payments</Note>
            {person.data.payments.length === 0 ? (
              <Note>No payments.</Note>
            ) : (
              person.data.payments.map((row) => (
                <Note key={row.id}>
                  {row.date} · {row.name} · {kes(row.amountKes)}
                </Note>
              ))
            )}
          </View>
        ) : null}
      </Section>
    </View>
  );
}

function Breakdown({
  rows,
}: {
  rows: SpendingOverview["headings"];
}): JSX.Element {
  return (
    <View className="gap-3">
      {rows.map((row) => (
        <View key={row.id} className="gap-1 border-b border-gray-200 pb-3">
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 text-sm font-medium text-gray-900">
              {row.name}
            </Text>
            <Text
              selectable
              className="flex-1 text-right text-sm font-semibold text-gray-900"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {kes(row.currentKes)}
            </Text>
          </View>
          <Note>Previous month: {kes(row.previousKes)}</Note>
        </View>
      ))}
    </View>
  );
}

/** Uses the existing caller-scoped APIs; no company summary is requested. */
export function EmployeeHomeContent({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const router = useRouter();
  const claims = useClaimList(organizationId);
  const floats = useFloats(organizationId, { mine: true });
  const salary = useMySalaryPayments(organizationId);
  const { refetch: refreshClaims } = claims;
  const { refetch: refreshFloats } = floats;
  const { refetch: refreshSalary } = salary;
  useFocusEffect(
    useCallback(() => {
      void refreshClaims();
      void refreshFloats();
      void refreshSalary();
    }, [refreshClaims, refreshFloats, refreshSalary]),
  );
  return (
    <View className="gap-6">
      <Section title="Your claims">
        {claims.isPending ? (
          <Note>Loading claims…</Note>
        ) : claims.isError ? (
          <Note>{describeApiError(claims.error)}</Note>
        ) : (
          <>
            {claims.data.pages
              .flatMap((page) => page.claims)
              .slice(0, 5)
              .map((row) => (
                <ListRow
                  key={row.id}
                  title={row.merchant}
                  subtitle={`${kes(row.amountKes)} · ${row.status.replaceAll("_", " ")}`}
                  onPress={() =>
                    router.push({
                      pathname: "/claims/[claimId]",
                      params: { claimId: row.id },
                    })
                  }
                />
              ))}
            {claims.data.pages[0]?.claims.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No claims yet"
                message="Add a receipt to claim back a purchase."
              />
            ) : null}
          </>
        )}
        <Button
          label="View all claims"
          variant="secondary"
          onPress={() => router.push("/claims")}
        />
      </Section>
      <Section title="Your float balance">
        {floats.isPending ? (
          <Note>Loading petty cash…</Note>
        ) : floats.isError ? (
          <Note>{describeApiError(floats.error)}</Note>
        ) : (
          <>
            <Text
              selectable
              className="text-3xl font-semibold text-gray-900"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {kes(openFloatLeft(floats.data.floats))}
            </Text>
            <Note>
              {floats.data.floats.filter((row) => row.status === "open").length}{" "}
              open floats
            </Note>
          </>
        )}
        <Button
          label="View petty cash"
          variant="secondary"
          onPress={() => router.push("/petty-cash")}
        />
      </Section>
      <Section title="Your salary payments">
        {salary.isPending ? (
          <Note>Loading salary payments…</Note>
        ) : salary.isError ? (
          <Note>{describeApiError(salary.error)}</Note>
        ) : salary.data.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="No salary payments yet"
            message="Your salary payments will appear here once they are processed."
          />
        ) : (
          salary.data.slice(0, 5).map((row) => (
            <Note key={row.id}>
              {row.payDate} · {kes(row.amountKes)} ·{" "}
              {row.status.replaceAll("_", " ")}
            </Note>
          ))
        )}
        <Button
          label="View salary payments"
          variant="secondary"
          onPress={() => router.push("/salary-payments")}
        />
      </Section>
    </View>
  );
}
