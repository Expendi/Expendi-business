import type { JSX } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import type { MySalaryPayment } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireCompany } from "~/features/claims/require-company";
import { MY_PAYMENT_STATUS_LABELS } from "~/features/payroll/payroll-display";
import { useMySalaryPayments } from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function SalaryPaymentsRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <SalaryPaymentsScreen company={company} />}
    </RequireCompany>
  );
}

/** Only ever the signed-in person's own salary payments (spec §4). */
function SalaryPaymentsScreen({ company }: { company: Company }): JSX.Element {
  const payments = useMySalaryPayments(company.organizationId);

  return (
    <Screen
      belowHeader
      refreshing={payments.isRefetching}
      onRefresh={() => void payments.refetch()}
    >
      {payments.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading your salary payments" />
      ) : payments.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(payments.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={payments.isFetching}
            onPress={() => void payments.refetch()}
          />
        </View>
      ) : payments.data.length === 0 ? (
        <Text className="text-base text-gray-600">
          Your salary payments from {company.name} show here once they’re on
          their way.
        </Text>
      ) : (
        <View className="gap-3">
          {payments.data.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function PaymentRow({ payment }: { payment: MySalaryPayment }): JSX.Element {
  const status = MY_PAYMENT_STATUS_LABELS[payment.status];
  const amount = `KES ${formatKesCents(payment.amountKes)}`;
  const what = payment.kind === "one_off" ? "Extra payment" : "Salary";
  const when = payment.paidOn
    ? `Paid ${formatIsoDate(payment.paidOn)}`
    : `Pay day ${formatIsoDate(payment.payDate)}`;
  return (
    <View
      accessibilityLabel={`${what}, ${amount}, ${when}, ${status.label}`}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">{what}</Text>
          <Text className="text-sm text-gray-600">{when}</Text>
        </View>
        <Text className="text-base font-semibold text-gray-900">{amount}</Text>
      </View>
      <Badge label={status.label} tone={status.tone} />
    </View>
  );
}
