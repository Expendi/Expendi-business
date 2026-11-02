import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { PAYROLL_MARGIN_MAX_PCT } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import {
  ApprovalPasskeyGate,
  describeApprovalError,
} from "~/features/approval";
import { ReviewRow } from "~/features/claims/claim-editor";
import { RequireAdmin } from "~/features/company/require-admin";
import { parseMarginPct } from "~/features/payroll/payroll-payment";
import {
  useChangePayrollMargin,
  usePayrollMargin,
} from "~/features/payroll/use-payroll-payment";
import { describeApiError } from "~/lib/api";

export default function PayrollSettingsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <ApprovalPasskeyGate>
            <MarginSettings company={company} />
          </ApprovalPasskeyGate>
        </Screen>
      )}
    </RequireAdmin>
  );
}

/**
 * The payroll cap's margin (spec §7.4): a run can pay its salaries plus
 * this percentage. Changing it needs the admin's passkey, and every admin
 * is emailed.
 */
function MarginSettings({ company }: { company: Company }): JSX.Element {
  const margin = usePayrollMargin(company.organizationId);
  const change = useChangePayrollMargin(company.organizationId);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  if (margin.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the margin" />;
  }
  if (margin.isError) {
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(margin.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={margin.isFetching}
          onPress={() => void margin.refetch()}
        />
      </View>
    );
  }

  function submit(): void {
    const marginPct = parseMarginPct(typed);
    if (marginPct === null) {
      setTypedError(
        `Enter the margin as a whole percentage, 0 to ${PAYROLL_MARGIN_MAX_PCT}.`,
      );
      return;
    }
    setTypedError(null);
    change.mutate(marginPct, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") setTyped("");
      },
    });
  }

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          Payroll cap
        </Text>
        <Text className="text-base text-gray-600">
          A payroll run can pay at most the salaries drafted into it plus this
          margin, so a mistake or a misuse can’t pay far more than the payroll
          that’s set up.
        </Text>
      </View>
      <ReviewRow label="Margin" value={`${margin.data.marginPct}%`} />
      <TextField
        label="New margin (%)"
        value={typed}
        onChangeText={setTyped}
        placeholder={String(margin.data.marginPct)}
        keyboardType="number-pad"
        maxLength={3}
      />
      <ErrorMessage message={typedError} />
      <Text className="text-sm text-gray-600">
        You confirm the change with your passkey. Every admin gets an email, and
        draft payroll runs use the new margin at once.
      </Text>
      {change.data?.status === "approved" ? (
        <Text className="text-sm text-gray-700">
          Saved. The margin is now {change.data.result.marginPct}%.
        </Text>
      ) : null}
      {change.data?.status === "cancelled" ? (
        <Text className="text-sm text-gray-600">
          Cancelled. Nothing changed.
        </Text>
      ) : null}
      <ErrorMessage
        message={change.isError ? describeApprovalError(change.error) : null}
      />
      <Button
        label="Change with passkey"
        loading={change.isPending}
        disabled={typed.trim() === ""}
        onPress={submit}
      />
    </View>
  );
}
