import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";

import type { PayrollRun } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { ListRow } from "~/components/list-row";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  DRAFT_TIMING,
  RUN_STATUS_LABELS,
} from "~/features/payroll/payroll-display";
import { usePayrollRuns } from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayrollRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PayrollScreen company={company} />}
    </RequireAdmin>
  );
}

function PayrollScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const runs = usePayrollRuns(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={runs.isRefetching}
      onRefresh={() => void runs.refetch()}
    >
      <ListRow
        title="Salaries"
        subtitle="Who’s on payroll, their net pay and pay day"
        onPress={() => router.push("/payroll/salaries")}
      />
      <ListRow
        title="Payroll cap"
        subtitle="How far a run can go beyond the salaries set up"
        onPress={() => router.push("/payroll/settings")}
      />

      <View className="gap-3">
        <Text
          accessibilityRole="header"
          className="text-sm font-semibold uppercase tracking-wide text-gray-500"
        >
          Payroll runs
        </Text>
        {runs.isPending ? (
          <ActivityIndicator accessibilityLabel="Loading payroll runs" />
        ) : runs.isError ? (
          <View className="gap-4">
            <ErrorMessage message={describeApiError(runs.error)} />
            <Button
              label="Try again"
              variant="secondary"
              loading={runs.isFetching}
              onPress={() => void runs.refetch()}
            />
          </View>
        ) : runs.data.length === 0 ? (
          <Text className="text-base text-gray-600">{DRAFT_TIMING}</Text>
        ) : (
          runs.data.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              onPress={() =>
                router.push({
                  pathname: "/payroll/runs/[runId]",
                  params: { runId: run.id },
                })
              }
            />
          ))
        )}
      </View>
    </Screen>
  );
}

function RunRow({
  run,
  onPress,
}: {
  run: PayrollRun;
  onPress: () => void;
}): JSX.Element {
  const status = RUN_STATUS_LABELS[run.status];
  const total = `KES ${formatKesCents(run.totalKes)}`;
  const people = `${run.people} ${run.people === 1 ? "person" : "people"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Payroll for ${formatIsoDate(run.payDate)}, ${people}, ${total}, ${status.label}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            Pay day {formatIsoDate(run.payDate)}
          </Text>
          <Text className="text-sm text-gray-600">{people}</Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{total}</Text>
      </View>
      <Badge label={status.label} tone={status.tone} />
    </Pressable>
  );
}
