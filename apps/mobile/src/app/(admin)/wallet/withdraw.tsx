import type { JSX } from "react";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { Withdrawal, WithdrawalAddress } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { CopyButton } from "~/components/copy-button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import {
  ApprovalPasskeyGate,
  describeApprovalError,
} from "~/features/approval";
import { RequireAdmin } from "~/features/company/require-admin";
import { addressOnChain } from "~/features/wallet/chain-display";
import { parseUsdcAmount } from "~/features/wallet/usdc-amount";
import { useCompanyWallet } from "~/features/wallet/use-company-wallet";
import {
  useWithdraw,
  WithdrawalMismatchError,
} from "~/features/wallet/use-withdraw";
import { useWithdrawalAddresses } from "~/features/wallet/use-withdrawal-addresses";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";

export default function WithdrawRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <ApprovalPasskeyGate>
            <WithdrawFlow company={company} />
          </ApprovalPasskeyGate>
        </Screen>
      )}
    </RequireAdmin>
  );
}

interface Draft {
  /** New for each review, so a retry of the same review is the same withdrawal. */
  readonly requestId: string;
  readonly address: WithdrawalAddress;
  readonly amountUsdc: string;
}

function WithdrawFlow({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const wallet = useCompanyWallet(company.organizationId);
  const addresses = useWithdrawalAddresses(company.organizationId);
  const [draft, setDraft] = useState<Draft | null>(null);

  if (wallet.isPending || addresses.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the wallet" />;
  }
  if (wallet.isError || addresses.isError) {
    return (
      <View className="gap-4">
        <ErrorMessage
          message={describeApiError(wallet.error ?? addresses.error)}
        />
        <Button
          label="Try again"
          variant="secondary"
          onPress={() => {
            void wallet.refetch();
            void addresses.refetch();
          }}
        />
      </View>
    );
  }
  if (wallet.data.status !== "active") {
    return (
      <Text className="text-base text-gray-600">
        The wallet isn’t ready yet. Finish setting it up on the wallet screen.
      </Text>
    );
  }
  if (addresses.data.length === 0) {
    return (
      <View className="gap-4">
        <Text className="text-base text-gray-600">
          Withdrawals go only to addresses on the company’s allowlist. Add one
          first.
        </Text>
        <Button
          label="Add an address"
          onPress={() => router.replace("/wallet/addresses")}
        />
      </View>
    );
  }

  return draft ? (
    <Review
      organizationId={company.organizationId}
      draft={draft}
      onEdit={() => setDraft(null)}
      onDone={() => router.back()}
    />
  ) : (
    <WithdrawForm
      addresses={addresses.data}
      balance={wallet.data.usdcBalance}
      onReview={(address, amountUsdc) =>
        setDraft({ requestId: Crypto.randomUUID(), address, amountUsdc })
      }
    />
  );
}

function WithdrawForm({
  addresses,
  balance,
  onReview,
}: {
  addresses: WithdrawalAddress[];
  balance: string;
  onReview: (address: WithdrawalAddress, amountUsdc: string) => void;
}): JSX.Element {
  const [addressId, setAddressId] = useState(addresses[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options: PickerOption<string>[] = addresses.map((address) => ({
    value: address.id,
    label: address.label,
    description: addressOnChain(address.chain, address.address),
  }));

  function handleReview(): void {
    const address = addresses.find((candidate) => candidate.id === addressId);
    if (!address) {
      setError("Choose where to send the USDC.");
      return;
    }
    const parsed = parseUsdcAmount(amount, balance);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onReview(address, parsed.baseUnits);
  }

  return (
    <View className="gap-6">
      <OptionPicker
        label="Send to"
        options={options}
        value={addressId}
        onChange={setAddressId}
      />
      <View className="gap-2">
        <TextField
          label="Amount (USDC)"
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="decimal-pad"
          autoCorrect={false}
        />
        <Text className="text-sm text-gray-600">
          Available: {formatUsdc(balance)} USDC
        </Text>
      </View>
      <ErrorMessage message={error} />
      <Button label="Review" onPress={handleReview} />
    </View>
  );
}

function describeWithdrawError(error: unknown): string {
  return error instanceof WithdrawalMismatchError
    ? error.message
    : describeApprovalError(error);
}

function Review({
  organizationId,
  draft,
  onEdit,
  onDone,
}: {
  organizationId: string;
  draft: Draft;
  onEdit: () => void;
  onDone: () => void;
}): JSX.Element {
  const withdraw = useWithdraw(organizationId);
  const outcome = withdraw.data;

  if (outcome?.status === "approved") {
    return <WithdrawalResult withdrawal={outcome.result} onDone={onDone} />;
  }

  return (
    <View className="gap-6">
      <Text
        accessibilityRole="header"
        className="text-2xl font-bold text-gray-900"
      >
        Review the withdrawal
      </Text>
      <View className="gap-4 rounded-2xl border border-gray-200 p-5">
        <Detail label="Amount" value={`${formatUsdc(draft.amountUsdc)} USDC`} />
        <Detail label="To" value={draft.address.label} />
        <Text selectable className="font-mono text-sm text-gray-700">
          {draft.address.address}
        </Text>
        <Detail
          label="Payee chain"
          value={PAYEE_CHAIN_NAMES[draft.address.chain]}
        />
        <Text className="text-sm text-gray-600">
          Expendi pays the network fees, so exactly this amount arrives.
        </Text>
      </View>
      {outcome?.status === "cancelled" ? (
        <Text className="text-sm text-gray-600">
          Cancelled. Nothing was sent.
        </Text>
      ) : null}
      <ErrorMessage
        message={
          withdraw.isError ? describeWithdrawError(withdraw.error) : null
        }
      />
      <View className="gap-3">
        <Button
          label="Withdraw with passkey"
          loading={withdraw.isPending}
          onPress={() =>
            withdraw.mutate({
              requestId: draft.requestId,
              addressId: draft.address.id,
              amountUsdc: draft.amountUsdc,
              chain: draft.address.chain,
              address: draft.address.address,
            })
          }
        />
        <Button
          label="Change"
          variant="ghost"
          disabled={withdraw.isPending}
          onPress={onEdit}
        />
      </View>
    </View>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <View className="flex-row justify-between gap-4">
      <Text className="flex-1 text-base text-gray-600">{label}</Text>
      <Text className="flex-1 text-right text-base font-semibold text-gray-900">
        {value}
      </Text>
    </View>
  );
}

const RESULTS: Record<
  "failed" | "review",
  { readonly title: string; readonly body: string }
> = {
  failed: {
    title: "Withdrawal failed",
    body: "Nothing was sent.",
  },
  review: {
    title: "We’re checking this withdrawal",
    body: "Its outcome isn’t clear yet, so Expendi is checking it. Don’t send it again.",
  },
};

function WithdrawalResult({
  withdrawal,
  onDone,
}: {
  withdrawal: Withdrawal;
  onDone: () => void;
}): JSX.Element {
  const result =
    withdrawal.status === "failed"
      ? RESULTS.failed
      : withdrawal.status === "needs_review"
        ? RESULTS.review
        : {
            title: "Withdrawal sent",
            body: `It’s on its way on ${PAYEE_CHAIN_NAMES[withdrawal.chain]} and shows in the wallet history.`,
          };

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {result.title}
        </Text>
        <Text className="text-base text-gray-600">
          {formatUsdc(withdrawal.amountUsdc)} USDC to {withdrawal.label}.{" "}
          {result.body}
        </Text>
        {withdrawal.failureReason ? (
          <Text className="text-sm text-gray-700">
            {withdrawal.failureReason}
          </Text>
        ) : null}
      </View>
      {withdrawal.txHash ? (
        <View className="gap-2">
          <Text className="text-sm text-gray-600">Transaction</Text>
          <Text selectable className="font-mono text-sm text-gray-700">
            {withdrawal.txHash}
          </Text>
          <CopyButton
            value={withdrawal.txHash}
            label="Copy transaction hash"
            failureMessage="Couldn’t copy. Select the hash and copy it instead."
          />
        </View>
      ) : null}
      <Button label="Done" onPress={onDone} />
    </View>
  );
}
