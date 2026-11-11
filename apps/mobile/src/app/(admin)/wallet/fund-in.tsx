import type { JSX } from "react";
import { ArrowDownLeft } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import type { FundIn, FundInChain } from "@expendi-business/shared";
import { FUND_IN_CHAIN_NAMES, FUND_IN_CHAINS } from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import type { FundInFieldErrors } from "~/features/wallet/fund-in";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { CopyButton } from "~/components/copy-button";
import { ErrorMessage } from "~/components/error-message";
import { ListRow } from "~/components/list-row";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { FUND_IN_STATUS, fundInDraft } from "~/features/wallet/fund-in";
import {
  useFundIn,
  useFundIns,
  useStartFundIn,
} from "~/features/wallet/use-fund-ins";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";

const RECENT_FUND_INS = 5;

export default function FundInRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <FundInFlow company={company} />
        </Screen>
      )}
    </RequireAdmin>
  );
}

/**
 * Fund-in from another chain: the admin says which chain the USDC comes
 * from and how much, and gets a one-time deposit
 * address. The screen then follows the fund-in until it reaches the company
 * wallet, is refunded, or expires.
 */
function FundInFlow({ company }: { company: Company }): JSX.Element {
  const [fundInId, setFundInId] = useState<string | null>(null);
  return fundInId ? (
    <FundInProgress
      organizationId={company.organizationId}
      fundInId={fundInId}
      onStartAnother={() => setFundInId(null)}
    />
  ) : (
    <View className="gap-8">
      <FundInForm
        organizationId={company.organizationId}
        onStarted={setFundInId}
      />
      <RecentFundIns
        organizationId={company.organizationId}
        onOpen={setFundInId}
      />
    </View>
  );
}

const CHAIN_OPTIONS: PickerOption<FundInChain>[] = FUND_IN_CHAINS.map(
  (chain) => ({ value: chain, label: FUND_IN_CHAIN_NAMES[chain] }),
);

function FundInForm({
  organizationId,
  onStarted,
}: {
  organizationId: string;
  onStarted: (fundInId: string) => void;
}): JSX.Element {
  const start = useStartFundIn(organizationId);
  const [chain, setChain] = useState<FundInChain>("base");
  const [amount, setAmount] = useState("");
  const [errors, setErrors] = useState<FundInFieldErrors>({});

  function handleStart(): void {
    const draft = fundInDraft(chain, amount);
    if (!draft.ok) {
      setErrors(draft.errors);
      return;
    }
    setErrors({});
    start.mutate(draft.request, {
      onSuccess: (fundIn) => onStarted(fundIn.id),
    });
  }

  return (
    <View className="gap-6">
      <Text className="text-base text-gray-600">
        Send USDC from another chain to the company wallet. You get a one-time
        address to send it to.
      </Text>
      <OptionPicker
        label="Chain you’re sending from"
        options={CHAIN_OPTIONS}
        value={chain}
        disabled={start.isPending}
        onChange={(next) => {
          setChain(next);
          setErrors({});
        }}
      />
      <View className="gap-2">
        <TextField
          label="Amount (USDC)"
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="decimal-pad"
          autoCorrect={false}
          editable={!start.isPending}
        />
        <Text className="text-sm text-gray-600">
          If the fund-in can’t be completed, the USDC comes back to your company
          wallet.
        </Text>
        <ErrorMessage message={errors.amount ?? null} />
      </View>
      <ErrorMessage
        message={start.isError ? describeApiError(start.error) : null}
      />
      <Button
        label="Get deposit address"
        loading={start.isPending}
        onPress={handleStart}
      />
    </View>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** The latest fund-ins, so one can be reopened after leaving the screen. */
function RecentFundIns({
  organizationId,
  onOpen,
}: {
  organizationId: string;
  onOpen: (fundInId: string) => void;
}): JSX.Element | null {
  const fundIns = useFundIns(organizationId);
  if (fundIns.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading recent fund-ins" />;
  }
  if (fundIns.isError) {
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(fundIns.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={fundIns.isFetching}
          onPress={() => void fundIns.refetch()}
        />
      </View>
    );
  }
  if (fundIns.data.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Recent fund-ins
      </Text>
      {fundIns.data.slice(0, RECENT_FUND_INS).map((fundIn) => (
        <ListRow
          key={fundIn.id}
          icon={ArrowDownLeft}
          title={`${formatUsdc(fundIn.amountIn)} USDC from ${FUND_IN_CHAIN_NAMES[fundIn.chain]}`}
          subtitle={`${FUND_IN_STATUS[fundIn.status].label} · ${dateFormat.format(new Date(fundIn.createdAt))}`}
          onPress={() => onOpen(fundIn.id)}
        />
      ))}
    </View>
  );
}

function FundInProgress({
  organizationId,
  fundInId,
  onStartAnother,
}: {
  organizationId: string;
  fundInId: string;
  onStartAnother: () => void;
}): JSX.Element {
  const fundIn = useFundIn(organizationId, fundInId);
  if (fundIn.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the fund-in" />;
  }
  if (!fundIn.data) {
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(fundIn.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={fundIn.isFetching}
          onPress={() => void fundIn.refetch()}
        />
      </View>
    );
  }
  return (
    <View className="gap-6">
      <FundInDetails fundIn={fundIn.data} />
      <Button
        label="Start another fund-in"
        variant="secondary"
        onPress={onStartAnother}
      />
    </View>
  );
}

function FundInDetails({ fundIn }: { fundIn: FundIn }): JSX.Element {
  const status = FUND_IN_STATUS[fundIn.status];
  const chainName = FUND_IN_CHAIN_NAMES[fundIn.chain];
  const awaiting = fundIn.status === "awaiting_deposit";
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {formatUsdc(fundIn.amountIn)} USDC from {chainName}
        </Text>
        <Badge label={status.label} tone={status.tone} />
        <Text accessibilityRole="alert" className="text-base text-gray-600">
          {status.note}
        </Text>
      </View>
      <View className="gap-4 rounded-2xl border border-gray-200 p-5">
        <Detail
          label="Send exactly"
          value={`${formatUsdc(fundIn.amountIn)} USDC`}
        />
        <Detail label="On" value={chainName} />
        <Detail
          label="Arrives in the wallet"
          value={`${formatUsdc(fundIn.amountOut)} USDC`}
        />
        <Detail
          label="Send by"
          value={dateFormat.format(new Date(fundIn.deadline))}
        />
      </View>
      {awaiting ? (
        <View className="gap-4">
          <Text
            accessibilityRole="header"
            className="text-lg font-semibold text-gray-900"
          >
            Deposit address · {chainName}
          </Text>
          <View className="items-center rounded-2xl border border-gray-200 bg-white p-6">
            <QRCode value={fundIn.depositAddress} size={180} />
          </View>
          <Text
            selectable
            accessibilityLabel={`Deposit address ${fundIn.depositAddress}`}
            className="rounded-xl border border-gray-200 bg-white p-4 font-mono text-sm leading-5 text-gray-900"
          >
            {fundIn.depositAddress}
          </Text>
          <CopyButton
            value={fundIn.depositAddress}
            label="Copy address"
            failureMessage="Couldn’t copy the address. Select it and copy it instead."
          />
          <View className="gap-1 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <Text className="text-base font-semibold text-amber-900">
              Send only USDC on {chainName}
            </Text>
            <Text className="text-sm text-amber-900">
              Send it in one transfer of exactly this amount. This address works
              once: if the fund-in can’t be completed, the USDC comes back to
              your company wallet.
            </Text>
          </View>
        </View>
      ) : null}
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
