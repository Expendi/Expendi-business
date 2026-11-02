import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";

import type {
  CashObligation,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  overviewPersonSchema,
  spendingOverviewSchema,
} from "@expendi-business/shared";

import { Button } from "~/components/button";
import { ListRow } from "~/components/list-row";
import { useClaimList } from "~/features/claims/use-claims";
import { useMySalaryPayments } from "~/features/payroll/use-payroll";
import { useFloats } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";
import { useApi } from "~/providers/api-provider";
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

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <View className="gap-3 border-t border-gray-200 pt-5">
      <Text
        accessibilityRole="header"
        className="text-lg font-semibold text-gray-900"
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
function Note({ children }: { children: ReactNode }): JSX.Element {
  return <Text className="text-sm text-gray-600">{children}</Text>;
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
  });
  if (overview.isPending) return <Note>Loading spending overview…</Note>;
  if (overview.isError)
    return (
      <View className="gap-2">
        <Note>{describeApiError(overview.error)}</Note>
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
    <View className="gap-6">
      <View className="gap-2 rounded-xl bg-gray-900 p-5">
        <Text className="text-sm text-gray-300">
          Cash check · through {data.cash.through}
        </Text>
        <Text className="text-2xl font-bold text-white">
          {cashHeadline(data.cash)}
        </Text>
        <Text className="text-base text-white">
          {formatUsdc(data.cash.balanceUsdc)} USDC ·{" "}
          {data.cash.balanceKes === null
            ? "KES rate unavailable"
            : kes(data.cash.balanceKes)}
        </Text>
        <Text className="text-sm text-gray-300">
          Available after payments being made:{" "}
          {data.cash.availableKes === null
            ? "unavailable"
            : kes(data.cash.availableKes)}
        </Text>
        {outsideLine === null ? null : (
          <Text className="text-sm text-gray-300">{outsideLine}</Text>
        )}
        <Text className="text-sm text-gray-300">{cashFootnote(data.cash)}</Text>
      </View>
      <Section title="Where is the money going?">
        <View className="flex-row items-center justify-between gap-2">
          <Button
            label="Previous"
            variant="ghost"
            onPress={() => setMonth(shiftMonth(data.month, -1))}
          />
          <Text className="text-base font-semibold">{data.month}</Text>
          <Button
            label="Next"
            variant="ghost"
            onPress={() => setMonth(shiftMonth(data.month, 1))}
          />
        </View>
        <Text className="text-2xl font-bold text-gray-900">
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
      <Section title="What is outstanding?">
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
      <Section title="What needs to be paid next?">
        {data.cash.obligations.length === 0 ? (
          <Note>Nothing due in the next 30 days.</Note>
        ) : (
          data.cash.obligations.map((row) => (
            <View
              key={`${row.kind}:${row.id}:${row.dueOn}`}
              className="gap-2 border-b border-gray-100 pb-3"
            >
              <Text className="font-semibold text-gray-900">
                {row.name} · {obligationAmount(row)}
              </Text>
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
      <Section title="What has been paid?">
        {data.recentPayments.length === 0 ? (
          <Note>
            No payments in {data.previousMonth} or {data.month}.
          </Note>
        ) : (
          data.recentPayments.map((row) => (
            <View key={row.id} className="gap-1">
              <Text className="font-semibold text-gray-900">
                {row.name} · {kes(row.amountKes)}
              </Text>
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
      <Section title="Per person">
        {data.people.map((row) => (
          <ListRow
            key={row.id}
            title={row.name}
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
          <View className="gap-3 rounded-xl border border-gray-200 p-4">
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
        <View key={row.id} className="gap-1">
          <Text className="font-semibold text-gray-900">
            {row.name} · {kes(row.currentKes)}
          </Text>
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
              <Note>
                No claims yet. Add a receipt to claim back a purchase.
              </Note>
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
            <Text className="text-2xl font-bold text-gray-900">
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
          <Note>No salary payments yet.</Note>
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
