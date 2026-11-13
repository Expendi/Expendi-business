import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Image, Linking, View } from "react-native";

import type {
  BillDetail,
  BillFile,
  BillStatus,
} from "@expendi-business/shared";
import {
  BILL_REASON_MAX_LENGTH,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { AttachInvoice } from "~/features/bills/attach-invoice";
import { formatBillAmount, storedAmount } from "~/features/bills/bill-amount";
import {
  automaticCard,
  cardDeclineLine,
  cardPaymentInWords,
  formatEstimate,
  paidByCardAmount,
  paidByCardLabel,
  payingCard,
} from "~/features/bills/bill-card";
import { isPayable, joinBillIds } from "~/features/bills/bill-payment";
import { BillBadges, HEADING_LABELS } from "~/features/bills/bill-status";
import { useBill, useCancelBill } from "~/features/bills/use-bills";
import { CashOutReceiptRows } from "~/features/cash-out/cash-out-receipt";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

export default function BillRoute(): JSX.Element {
  return (
    <RequireAdmin>{(company) => <BillScreen company={company} />}</RequireAdmin>
  );
}

function BillScreen({ company }: { company: Company }): JSX.Element {
  const { billId } = useLocalSearchParams<{ billId: string }>();
  const bill = useBill(company.organizationId, billId);

  if (bill.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the bill" />
      </Screen>
    );
  }
  if (bill.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(bill.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={bill.isFetching}
          onPress={() => void bill.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={bill.isRefetching}
      onRefresh={() => void bill.refetch()}
    >
      <BillSummary bill={bill.data} />
      <BillFiles files={bill.data.files} />
      {isUnpaid(bill.data.status) && bill.data.payrollRunId === null ? (
        <BillActions company={company} bill={bill.data} />
      ) : null}
    </Screen>
  );
}

function BillSummary({ bill }: { bill: BillDetail }): JSX.Element {
  const heading =
    bill.overviewHeading === "transactions" ||
    bill.overviewHeading === "subscriptions"
      ? HEADING_LABELS[bill.overviewHeading]
      : "Salaries & personnel";
  const card = automaticCard(bill);
  const cardPayment = cardPaymentInWords(bill);
  const declineLine = cardDeclineLine(bill);
  const paidByCard = paidByCardLabel(bill);
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {bill.payee.name}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          {card
            ? formatEstimate(bill)
            : (formatBillAmount(bill) ?? "Amount not entered yet")}
        </Text>
        <BillBadges bill={bill} />
      </View>
      <CashOutReceiptRows receipts={bill.paymentReceipts} copyable />

      <View className="gap-4">
        <ReviewRow label="Due" value={formatIsoDate(bill.dueOn)} />
        {declineLine ? (
          <View className="gap-1">
            <ReviewRow label="Card declined" value={declineLine} />
            <Text className="text-sm text-gray-600">
              Load the Card balance or check the card on the web dashboard.
            </Text>
          </View>
        ) : null}
        <ReviewRow
          label="Amount"
          value={
            card
              ? "An estimate. The bill takes the Card purchase’s actual amount."
              : bill.variable
                ? "Variable, entered each time"
                : "Fixed"
          }
        />
        <ReviewRow label="Overview heading" value={heading} />
        <ReviewRow label="Category" value={bill.category.name} />
        {bill.reference ? (
          <ReviewRow label="Reference" value={bill.reference} />
        ) : null}
        {bill.notes ? <ReviewRow label="Notes" value={bill.notes} /> : null}
        {bill.adjustmentReason ? (
          <ReviewRow
            label="Why the amount changed"
            value={bill.adjustmentReason}
          />
        ) : null}
        {cardPayment ? (
          <ReviewRow label="How it’s paid" value={cardPayment} />
        ) : bill.payee.method === "outside" ? (
          <ReviewRow
            label="How it’s paid"
            value="Outside Expendi. Mark it paid once you’ve paid it."
          />
        ) : null}
        {paidByCard && bill.paidOn ? (
          <ReviewRow
            label={paidByCard}
            value={`${paidByCardAmount(bill) ?? "Amount not recorded"}, ${formatIsoDate(bill.paidOn)}`}
          />
        ) : null}
        {bill.status === "paid_outside" && bill.paidOn ? (
          <ReviewRow
            label="Paid outside Expendi"
            value={`${formatIsoDate(bill.paidOn)}, marked by ${bill.markedPaidBy?.name ?? bill.markedPaidBy?.email ?? "an admin"}`}
          />
        ) : null}
        {bill.paidOutsideNote ? (
          <ReviewRow label="Payment note" value={bill.paidOutsideNote} />
        ) : null}
        {bill.status === "cancelled" && bill.cancelledReason ? (
          <ReviewRow
            label={`Cancelled by ${bill.cancelledBy?.name ?? bill.cancelledBy?.email ?? "an admin"}`}
            value={bill.cancelledReason}
          />
        ) : null}
      </View>
    </>
  );
}

const FILE_TITLES: Record<BillFile["role"], string> = {
  invoice: "Invoice",
  proof: "Proof of payment",
};

function BillFiles({ files }: { files: BillFile[] }): JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Files
      </Text>
      {files.map((file) =>
        file.contentType.startsWith("image/") ? (
          <View key={file.id} className="gap-1">
            <Text className="text-sm text-gray-600">
              {FILE_TITLES[file.role]}
            </Text>
            <Image
              source={{ uri: file.url }}
              accessibilityLabel={FILE_TITLES[file.role]}
              accessibilityIgnoresInvertColors
              className="w-full rounded-xl bg-gray-100"
              style={{ aspectRatio: 3 / 4 }}
              resizeMode="contain"
            />
          </View>
        ) : (
          <Button
            key={file.id}
            label={`Open ${FILE_TITLES[file.role].toLowerCase()} (PDF)`}
            variant="secondary"
            onPress={() => void Linking.openURL(file.url)}
          />
        ),
      )}
    </View>
  );
}

function BillActions({
  company,
  bill,
}: {
  company: Company;
  bill: BillDetail;
}): JSX.Element {
  const router = useRouter();
  const cancel = useCancelBill(company.organizationId, bill.id);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const needsAmount = storedAmount(bill) === null;

  function closeCancel(): void {
    setCancelling(false);
    setReason("");
    cancel.reset();
  }

  const payable = isPayable(bill);
  const failed = bill.status === "payout_failed";
  /** The card pays it, so marking it paid is the exception, not the next step. */
  const automatic = payingCard(bill) !== null;

  return (
    <View className="gap-3">
      {payable ? (
        <Button
          label={failed ? "Retry payment" : "Pay"}
          onPress={() =>
            router.push({
              pathname: "/bills/pay",
              params: {
                billIds: joinBillIds([bill.id]),
                ...(failed && { retry: "1" }),
              },
            })
          }
        />
      ) : null}
      {failed ? (
        <Text className="text-sm text-gray-600">
          The last payment failed and nothing reached {bill.payee.name}. A retry
          is a new payment that needs your passkey again.
        </Text>
      ) : null}
      {needsAmount ? (
        <Text className="text-sm text-gray-600">
          {automatic
            ? "To mark it paid outside Expendi, enter the amount first."
            : "Enter the amount before paying or marking this bill paid."}
        </Text>
      ) : null}
      <Button
        label={needsAmount ? "Enter the amount" : "Mark paid outside Expendi"}
        variant={payable || automatic ? "secondary" : "primary"}
        onPress={() =>
          router.push({
            pathname: needsAmount
              ? "/bills/[billId]/edit"
              : "/bills/[billId]/mark-paid",
            params: { billId: bill.id },
          })
        }
      />
      {needsAmount ? null : (
        <Button
          label="Edit bill"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: "/bills/[billId]/edit",
              params: { billId: bill.id },
            })
          }
        />
      )}
      <AttachInvoice organizationId={company.organizationId} billId={bill.id} />
      <Button
        label="Cancel bill"
        variant="ghost"
        onPress={() => setCancelling(true)}
      />

      <ConfirmSheet
        visible={cancelling}
        title="Cancel this bill?"
        message={`${bill.payee.name} won’t be paid for this bill. It stays in the history with your reason.`}
        confirmLabel="Cancel bill"
        dismissLabel="Keep bill"
        busy={cancel.isPending}
        error={cancel.isError ? describeApiError(cancel.error) : null}
        onConfirm={() =>
          cancel.mutate({ reason }, { onSuccess: () => closeCancel() })
        }
        onCancel={closeCancel}
      >
        <TextField
          label="Why won’t it be paid?"
          value={reason}
          onChangeText={setReason}
          placeholder="Subscription cancelled"
          maxLength={BILL_REASON_MAX_LENGTH}
        />
      </ConfirmSheet>
    </View>
  );
}
