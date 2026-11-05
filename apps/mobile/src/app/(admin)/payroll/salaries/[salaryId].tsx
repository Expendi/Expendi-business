import type { JSX } from "react";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { Salary } from "@expendi-business/shared";
import { parseKesToCents } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import {
  ApprovalPasskeyGate,
  describeApprovalError,
} from "~/features/approval";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { KIND_LABELS } from "~/features/payees/payee-display";
import {
  draftFromSalary,
  payDayInWords,
  SALARY_STATE_LABELS,
} from "~/features/payroll/payroll-display";
import { SalaryForm } from "~/features/payroll/salary-form";
import {
  useChangeSalaryAmount,
  useEndSalary,
  useSalary,
  useUpdateSalary,
} from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function SalaryRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <SalaryScreen company={company} />}
    </RequireAdmin>
  );
}

function SalaryScreen({ company }: { company: Company }): JSX.Element {
  const { salaryId } = useLocalSearchParams<{ salaryId: string }>();
  const salary = useSalary(company.organizationId, salaryId);

  if (salary.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the salary" />
      </Screen>
    );
  }
  if (salary.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(salary.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={salary.isFetching}
          onPress={() => void salary.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={salary.isRefetching}
      onRefresh={() => void salary.refetch()}
    >
      <SalarySummary salary={salary.data} />
      {salary.data.state === "ended" ? null : (
        <>
          <NetPay company={company} salary={salary.data} />
          <PayDayAndCategory company={company} salary={salary.data} />
          <EndSalary company={company} salary={salary.data} />
        </>
      )}
    </Screen>
  );
}

function SalarySummary({ salary }: { salary: Salary }): JSX.Element {
  const state = SALARY_STATE_LABELS[salary.state];
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {salary.payee.name}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          KES {formatKesCents(salary.amountKes)}
        </Text>
        <Badge label={state.label} tone={state.tone} />
      </View>
      <View className="gap-4">
        <ReviewRow label="Who" value={KIND_LABELS[salary.payee.kind]} />
        <ReviewRow label="Paid" value={payDayInWords(salary.payDay)} />
        <ReviewRow
          label="Next pay date"
          value={
            salary.nextPayDate
              ? formatIsoDate(salary.nextPayDate)
              : "No more pay"
          }
        />
        <ReviewRow label="Started" value={formatIsoDate(salary.startsOn)} />
        {salary.endsOn ? (
          <ReviewRow label="Ended" value={formatIsoDate(salary.endsOn)} />
        ) : null}
        <ReviewRow label="Category" value={salary.category.name} />
        {salary.payee.payoutPhoneConfirmed === false ? (
          <Text className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            {salary.payee.name} hasn’t confirmed their M-Pesa number yet, so
            they can’t be paid until they do.
          </Text>
        ) : null}
      </View>
    </>
  );
}

/**
 * New net pay needs the admin's passkey and emails every admin (spec
 * §7.4): it moves the payroll cap.
 */
function NetPay({
  company,
  salary,
}: {
  company: Company;
  salary: Salary;
}): JSX.Element {
  const change = useChangeSalaryAmount(company.organizationId, salary.id);
  const [amount, setAmount] = useState("");
  const [invalid, setInvalid] = useState(false);

  function save(): void {
    const cents = parseKesToCents(amount);
    if (cents === null || cents <= 0n) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    change.mutate(amount.trim(), {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") setAmount("");
      },
    });
  }

  return (
    <View className="gap-3">
      <Text
        accessibilityRole="header"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Change net pay
      </Text>
      <ApprovalPasskeyGate>
        <View className="gap-3">
          <TextField
            label="New monthly net pay (KES)"
            value={amount}
            onChangeText={setAmount}
            placeholder={formatKesCents(salary.amountKes)}
            keyboardType="decimal-pad"
          />
          <ErrorMessage
            message={
              invalid
                ? "Enter the amount in KES, e.g. 45,000 or 45,000.50."
                : null
            }
          />
          <Text className="text-sm text-gray-600">
            You confirm with your passkey, and every admin gets an email. It
            applies to payroll runs drafted from now on; to change a run that’s
            already drafted, change it in the run.
          </Text>
          <ErrorMessage
            message={
              change.isError ? describeApprovalError(change.error) : null
            }
          />
          <Button
            label="Confirm new pay"
            loading={change.isPending}
            onPress={save}
          />
        </View>
      </ApprovalPasskeyGate>
    </View>
  );
}

function PayDayAndCategory({
  company,
  salary,
}: {
  company: Company;
  salary: Salary;
}): JSX.Element {
  const update = useUpdateSalary(company.organizationId, salary.id);
  return (
    <View className="gap-4">
      <Text
        accessibilityRole="header"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Pay day and category
      </Text>
      <SalaryForm
        key={salary.updatedAt}
        organizationId={company.organizationId}
        initialDraft={draftFromSalary(salary)}
        salary={salary}
        submitLabel="Save"
        submitting={update.isPending}
        submitError={update.error}
        onSubmit={(request) => update.mutate(request)}
      />
    </View>
  );
}

function EndSalary({
  company,
  salary,
}: {
  company: Company;
  salary: Salary;
}): JSX.Element {
  const end = useEndSalary(company.organizationId, salary.id);
  const [confirming, setConfirming] = useState(false);

  function close(): void {
    setConfirming(false);
    end.reset();
  }

  return (
    <>
      <Button
        label="Take off payroll"
        variant="ghost"
        onPress={() => setConfirming(true)}
      />
      <ConfirmSheet
        visible={confirming}
        title="Take them off payroll?"
        message={`${salary.payee.name} won’t be in any new payroll run. A run already drafted keeps them until you leave them out of it. This can’t be undone.`}
        confirmLabel="Take off payroll"
        dismissLabel="Keep them"
        busy={end.isPending}
        error={end.isError ? describeApiError(end.error) : null}
        onConfirm={() => end.mutate(undefined, { onSuccess: close })}
        onCancel={close}
      />
    </>
  );
}
