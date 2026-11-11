import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  PayrollPayment,
  PayrollRunDetail,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import type { DraftChange } from "~/features/payroll/use-payroll";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { LoadError } from "~/components/load-error";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { BillStatusBadge } from "~/features/bills/bill-status";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatShortDate, localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { capRoom, RUN_STATUS_LABELS } from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import {
  useChangeDraftRun,
  usePayrollRun,
} from "~/features/payroll/use-payroll";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function PayrollRunRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PayrollRunScreen company={company} />}
    </RequireAdmin>
  );
}

function PayrollRunScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const run = usePayrollRun(company.organizationId, runId);

  if (run.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the payroll run" />
      </Screen>
    );
  }
  if (run.isError) {
    return (
      <Screen belowHeader>
        <LoadError
          message={describeApiError(run.error)}
          retrying={run.isFetching}
          onRetry={() => void run.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={run.isRefetching}
      onRefresh={() => void run.refetch()}
    >
      <RunSummary run={run.data} />
      <Payments
        company={company}
        run={run.data}
        onRetry={(billId) =>
          router.push({
            pathname: "/payroll/pay",
            params: { runId: run.data.id, billId },
          })
        }
      />
      {run.data.status === "draft" ? (
        <>
          <AddOneOff company={company} run={run.data} />
          <Button
            label="Approve & pay all"
            disabled={capRoom(run.data).overCap}
            onPress={() =>
              router.push({
                pathname: "/payroll/pay",
                params: { runId: run.data.id },
              })
            }
          />
        </>
      ) : null}
    </Screen>
  );
}

function RunSummary({ run }: { run: PayrollRunDetail }): JSX.Element {
  const status = RUN_STATUS_LABELS[run.status];
  const room = capRoom(run);
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          Pay day {formatShortDate(run.payDate, localIsoDate(new Date()))}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          KES {formatKesCents(run.totalKes)}
        </Text>
        <Badge label={status.label} tone={status.tone} />
      </View>
      <View className="gap-4">
        {progressInWords(run) ? (
          <ReviewRow label="Payments" value={progressInWords(run) ?? ""} />
        ) : null}
        <ReviewRow
          label="People"
          value={
            run.leftOut === 0
              ? String(run.people)
              : `${run.people}, and ${run.leftOut} left out`
          }
        />
        <ReviewRow
          label="Cap"
          value={`KES ${formatKesCents(run.capKes)}: salaries of KES ${formatKesCents(run.salariesKes)} plus the company’s margin`}
        />
        {room.overCap ? (
          <Text className="rounded-2xl bg-error-50 p-4 text-sm text-error-700">
            This run is KES {formatKesCents(room.cents)} over its cap, so it
            can’t be paid as it is. Lower someone’s pay or leave someone out.
          </Text>
        ) : (
          <ReviewRow
            label="Room under the cap"
            value={`KES ${formatKesCents(room.cents)}`}
          />
        )}
      </View>
    </>
  );
}

type SheetState =
  | { readonly kind: "adjust"; readonly payment: PayrollPayment }
  | { readonly kind: "leave_out"; readonly payment: PayrollPayment };

function Payments({
  company,
  run,
  onRetry,
}: {
  company: Company;
  run: PayrollRunDetail;
  onRetry: (billId: string) => void;
}): JSX.Element {
  const change = useChangeDraftRun(company.organizationId, run.id);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const editable = run.status === "draft";

  function open(next: SheetState): void {
    change.reset();
    setAmount("");
    setReason("");
    setSheet(next);
  }

  function close(): void {
    setSheet(null);
    change.reset();
  }

  function confirm(): void {
    if (!sheet) return;
    const request: DraftChange =
      sheet.kind === "adjust"
        ? {
            action: "adjust",
            billId: sheet.payment.billId,
            request: { amountKes: amount.trim(), reason },
          }
        : { action: "leave_out", billId: sheet.payment.billId, reason };
    change.mutate(request, { onSuccess: close });
  }

  return (
    <View className="gap-3">
      <Text
        accessibilityRole="header"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Who’s paid
      </Text>
      {run.payments.map((payment) => (
        <PaymentCard
          key={payment.billId}
          payment={payment}
          editable={editable && payment.leftOut === null}
          onAdjust={() => open({ kind: "adjust", payment })}
          onLeaveOut={() => open({ kind: "leave_out", payment })}
          onRetry={() => onRetry(payment.billId)}
        />
      ))}

      <ConfirmSheet
        visible={sheet !== null}
        title={
          sheet?.kind === "adjust"
            ? `Change ${sheet.payment.payee.name}’s pay`
            : `Leave ${sheet?.payment.payee.name ?? ""} out?`
        }
        message={
          sheet?.kind === "adjust"
            ? "For this run only; their salary stays as it is."
            : "They won’t be paid in this run. Their salary stays, so they’re in the next one."
        }
        confirmLabel={sheet?.kind === "adjust" ? "Change pay" : "Leave out"}
        dismissLabel="Keep as it is"
        busy={change.isPending}
        error={change.isError ? describeApiError(change.error) : null}
        onConfirm={confirm}
        onCancel={close}
      >
        <View className="gap-3">
          {sheet?.kind === "adjust" ? (
            <TextField
              label="Pay in this run (KES)"
              value={amount}
              onChangeText={setAmount}
              placeholder={formatKesCents(sheet.payment.amountKes)}
              keyboardType="decimal-pad"
            />
          ) : null}
          <TextField
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder={
              sheet?.kind === "adjust"
                ? "e.g. Unpaid leave"
                : "e.g. Left in October"
            }
            maxLength={300}
          />
        </View>
      </ConfirmSheet>
    </View>
  );
}

function PaymentCard({
  payment,
  editable,
  onAdjust,
  onLeaveOut,
  onRetry,
}: {
  payment: PayrollPayment;
  editable: boolean;
  onAdjust: () => void;
  onLeaveOut: () => void;
  onRetry: () => void;
}): JSX.Element {
  const leftOut = payment.leftOut !== null;
  const amount = `KES ${formatKesCents(payment.amountKes)}`;
  return (
    <View
      accessibilityLabel={`${payment.payee.name}, ${amount}${leftOut ? ", left out" : ""}`}
      className={`gap-2 rounded-xl border border-gray-200 px-4 py-3 ${leftOut ? "bg-gray-50" : ""}`}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {payment.payee.name}
          </Text>
          <Text className="text-sm text-gray-600">
            {payment.kind === "one_off"
              ? `One-off: ${payment.note ?? ""}`
              : "Salary"}
          </Text>
        </View>
        <Text
          className={`text-base font-semibold ${leftOut ? "text-gray-400 line-through" : "text-gray-900"}`}
        >
          {amount}
        </Text>
      </View>
      {payment.adjustmentReason ? (
        <Text className="text-sm text-gray-600">
          Changed for this run: {payment.adjustmentReason}
        </Text>
      ) : null}
      {payment.leftOut ? (
        <Text className="text-sm text-gray-600">
          Left out: {payment.leftOut.reason}
        </Text>
      ) : (
        <BillStatusBadge status={payment.status} />
      )}
      {payment.payee.payoutPhoneConfirmed === false ? (
        <Text className="text-sm text-error-700">
          Hasn’t confirmed their M-Pesa number yet.
        </Text>
      ) : null}
      {payment.status === "payout_failed" ? (
        <Button
          label={`Retry ${payment.payee.name}’s payment`}
          variant="secondary"
          onPress={onRetry}
        />
      ) : null}
      {editable ? (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button label="Change pay" variant="secondary" onPress={onAdjust} />
          </View>
          <View className="flex-1">
            <Button label="Leave out" variant="ghost" onPress={onLeaveOut} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** An extra payment in this run, e.g. a bonus, to someone already in it. */
function AddOneOff({
  company,
  run,
}: {
  company: Company;
  run: PayrollRunDetail;
}): JSX.Element | null {
  const change = useChangeDraftRun(company.organizationId, run.id);
  const [open, setOpen] = useState(false);
  const [payeeId, setPayeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const people = run.payments
    .filter((payment) => payment.leftOut === null)
    .map((payment) => payment.payee)
    .filter(
      (payee, index, all) =>
        all.findIndex((other) => other.id === payee.id) === index,
    );

  function close(): void {
    setOpen(false);
    setPayeeId("");
    setAmount("");
    setReason("");
    change.reset();
  }

  if (people.length === 0) return null;

  return (
    <>
      <Button
        label="Add a one-off payment"
        variant="secondary"
        onPress={() => setOpen(true)}
      />
      <ConfirmSheet
        visible={open}
        title="Add a one-off payment"
        message="For this run only, e.g. a bonus or overtime. It’s paid with everyone else."
        confirmLabel="Add payment"
        dismissLabel="Don’t add"
        busy={change.isPending}
        error={change.isError ? describeApiError(change.error) : null}
        onConfirm={() =>
          change.mutate(
            {
              action: "one_off",
              request: { payeeId, amountKes: amount.trim(), reason },
            },
            { onSuccess: close },
          )
        }
        onCancel={close}
      >
        <View className="gap-3">
          <OptionPicker
            label="Who"
            options={people.map((payee) => ({
              value: payee.id,
              label: payee.name,
            }))}
            value={payeeId}
            onChange={setPayeeId}
          />
          <TextField
            label="Amount (KES)"
            value={amount}
            onChangeText={setAmount}
            placeholder="5,000.00"
            keyboardType="decimal-pad"
          />
          <TextField
            label="What it’s for"
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Overtime in November"
            maxLength={300}
          />
        </View>
      </ConfirmSheet>
    </>
  );
}
