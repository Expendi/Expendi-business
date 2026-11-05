import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Image, Linking, View } from "react-native";

import type {
  CompanySpendingDetail,
  CompanySpendingReceipt,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { ReviewRow } from "~/features/claims/claim-editor";
import { formatIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  ACCOUNT_KIND_LABELS,
  describeSpendingWarning,
  HEADING_LABELS,
} from "~/features/spending/spending-draft";
import { useCompanySpending } from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function SpendingRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <SpendingScreen company={company} />}
    </RequireAdmin>
  );
}

function SpendingScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { spendingId } = useLocalSearchParams<{ spendingId: string }>();
  const spending = useCompanySpending(company.organizationId, spendingId);

  if (spending.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the spending" />
      </Screen>
    );
  }
  if (spending.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(spending.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={spending.isFetching}
          onPress={() => void spending.refetch()}
        />
      </Screen>
    );
  }

  const record = spending.data;
  return (
    <Screen
      belowHeader
      refreshing={spending.isRefetching}
      onRefresh={() => void spending.refetch()}
    >
      <SpendingSummary spending={record} />
      <SpendingWarnings spending={record} />
      <Receipts receipts={record.receipts} />
      <View className="gap-3">
        <Button
          label="Edit"
          onPress={() =>
            router.push({
              pathname: "/spending/[spendingId]/edit",
              params: { spendingId: record.id },
            })
          }
        />
        {record.bill ? (
          <Button
            label="Open the bill"
            variant="secondary"
            onPress={() => {
              if (record.bill) {
                router.push({
                  pathname: "/bills/[billId]",
                  params: { billId: record.bill.id },
                });
              }
            }}
          />
        ) : null}
      </View>
    </Screen>
  );
}

function SpendingSummary({
  spending,
}: {
  spending: CompanySpendingDetail;
}): JSX.Element {
  const account = spending.paidFromAccount;
  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {spending.merchant}
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          KES {formatKesCents(spending.amountKes)}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Badge label="Recorded" tone="success" />
          {spending.noReceipt ? (
            <Badge label="No receipt" tone="warning" />
          ) : null}
        </View>
      </View>

      <View className="gap-4">
        <ReviewRow label="Date paid" value={formatIsoDate(spending.spentOn)} />
        <ReviewRow
          label="Paid from"
          value={
            account
              ? `${account.name} (${ACCOUNT_KIND_LABELS[account.kind]}${account.archived ? ", archived" : ""})`
              : "Not specified. Edit to set it."
          }
        />
        <ReviewRow
          label="Overview heading"
          value={HEADING_LABELS[spending.overviewHeading]}
        />
        <ReviewRow label="Category" value={spending.category.name} />
        {spending.description ? (
          <ReviewRow label="What it was for" value={spending.description} />
        ) : null}
        {spending.noReceiptReason ? (
          <ReviewRow
            label="Saved without a receipt because"
            value={spending.noReceiptReason}
          />
        ) : null}
        {spending.bill ? (
          <ReviewRow
            label="From a bill marked paid"
            value={`${spending.bill.payee.name}, due ${formatIsoDate(spending.bill.dueOn)}${spending.bill.reference ? ` · ${spending.bill.reference}` : ""}`}
          />
        ) : null}
        {spending.mpesaCode ? (
          <ReviewRow label="M-Pesa code" value={spending.mpesaCode} />
        ) : null}
        {spending.etimsInvoiceNumber ? (
          <ReviewRow
            label="eTIMS invoice number"
            value={spending.etimsInvoiceNumber}
          />
        ) : null}
        {spending.etimsSupplierPin ? (
          <ReviewRow
            label="Supplier’s KRA PIN"
            value={spending.etimsSupplierPin}
          />
        ) : null}
        <ReviewRow
          label="Recorded by"
          value={spending.recordedBy.name ?? spending.recordedBy.email}
        />
      </View>
    </>
  );
}

function SpendingWarnings({
  spending,
}: {
  spending: CompanySpendingDetail;
}): JSX.Element | null {
  if (spending.warnings.length === 0) return null;
  return (
    <View className="gap-2 rounded-xl bg-amber-50 p-3">
      <Text className="text-sm font-semibold text-amber-800">Check this</Text>
      {spending.warnings.map((warning) => (
        <Text
          key={`${warning.code}-${warning.spentOn}`}
          className="text-sm text-amber-800"
        >
          {describeSpendingWarning(warning)}
        </Text>
      ))}
    </View>
  );
}

const BILL_FILE_TITLES = { invoice: "Bill invoice", proof: "Proof of payment" };

function receiptTitle(receipt: CompanySpendingReceipt): string {
  return receipt.billRole === null
    ? "Receipt"
    : BILL_FILE_TITLES[receipt.billRole];
}

function Receipts({
  receipts,
}: {
  receipts: CompanySpendingReceipt[];
}): JSX.Element | null {
  if (receipts.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Receipts
      </Text>
      {receipts.map((receipt) =>
        receipt.kind === "sms_text" ? (
          <View
            key={receipt.id}
            className="gap-1 rounded-xl border border-gray-200 p-3"
          >
            <Text className="text-sm font-medium text-gray-700">
              M-Pesa SMS
            </Text>
            <Text className="text-sm text-gray-600">{receipt.text}</Text>
          </View>
        ) : receipt.contentType.startsWith("image/") ? (
          <View key={receipt.id} className="gap-1">
            <Text className="text-sm text-gray-600">
              {receiptTitle(receipt)}
            </Text>
            <Image
              source={{ uri: receipt.url }}
              accessibilityLabel={receiptTitle(receipt)}
              accessibilityIgnoresInvertColors
              className="w-full rounded-xl bg-gray-100"
              style={{ aspectRatio: 3 / 4 }}
              resizeMode="contain"
            />
          </View>
        ) : (
          <Button
            key={receipt.id}
            label={`Open ${receiptTitle(receipt).toLowerCase()} (PDF)`}
            variant="secondary"
            onPress={() => void Linking.openURL(receipt.url)}
          />
        ),
      )}
    </View>
  );
}
