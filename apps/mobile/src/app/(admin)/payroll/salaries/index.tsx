import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Salary } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  payDayInWords,
  SALARY_STATE_LABELS,
} from "~/features/payroll/payroll-display";
import { useSalaries } from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function SalariesRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <SalariesScreen company={company} />}
    </RequireAdmin>
  );
}

function SalariesScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const salaries = useSalaries(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={salaries.isRefetching}
      onRefresh={() => void salaries.refetch()}
    >
      <Button
        label="New salary"
        onPress={() => router.push("/payroll/salaries/new")}
      />

      {salaries.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading salaries" />
      ) : salaries.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(salaries.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={salaries.isFetching}
            onPress={() => void salaries.refetch()}
          />
        </View>
      ) : salaries.data.length === 0 ? (
        <Text className="text-base text-gray-600">
          Set up each person’s net pay and pay day once. Only admins see
          salaries.
        </Text>
      ) : (
        <View className="gap-3">
          {salaries.data.map((salary) => (
            <SalaryRow
              key={salary.id}
              salary={salary}
              onPress={() =>
                router.push({
                  pathname: "/payroll/salaries/[salaryId]",
                  params: { salaryId: salary.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function SalaryRow({
  salary,
  onPress,
}: {
  salary: Salary;
  onPress: () => void;
}): JSX.Element {
  const amount = `KES ${formatKesCents(salary.amountKes)}`;
  const state = SALARY_STATE_LABELS[salary.state];
  const next = salary.nextPayDate
    ? `Next paid ${formatIsoDate(salary.nextPayDate)}`
    : "No more pay";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${salary.payee.name}, ${amount}, ${next}, ${state.label}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {salary.payee.name}
          </Text>
          <Text className="text-sm text-gray-600">
            {payDayInWords(salary.payDay)}
          </Text>
          <Text className="text-sm text-gray-600">{next}</Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{amount}</Text>
      </View>
      <Badge label={state.label} tone={state.tone} />
    </Pressable>
  );
}
