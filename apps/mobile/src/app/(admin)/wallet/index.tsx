import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  MapPin,
  Wallet,
} from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import type { ActiveWallet, WalletChain } from "@expendi-business/shared";
import { MAIN_CHAIN, PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { CopyButton } from "~/components/copy-button";
import { ErrorMessage } from "~/components/error-message";
import { ListRow } from "~/components/list-row";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  isMissingWallet,
  useCompanyWallet,
  useFinishWalletSetup,
} from "~/features/wallet/use-company-wallet";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatUsdc } from "~/lib/money";
import { colors } from "~/theme/colors";

export default function WalletRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <WalletScreen company={company} />}
    </RequireAdmin>
  );
}

function WalletScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { welcome } = useLocalSearchParams<{ welcome?: string }>();
  const wallet = useCompanyWallet(company.organizationId);
  const activeWallet = wallet.data?.status === "active" ? wallet.data : null;
  const needsSetup =
    wallet.data?.status === "creating" ||
    (wallet.isError && isMissingWallet(wallet.error));

  return (
    <Screen
      belowHeader
      refreshing={wallet.isRefetching}
      onRefresh={() => void wallet.refetch()}
    >
      {welcome ? (
        <View className="gap-1">
          <Text className="text-2xl font-bold text-gray-900">
            {company.name} is ready
          </Text>
          <Text className="text-base text-gray-600">
            Fund in with USDC to start paying claims.
          </Text>
        </View>
      ) : null}

      <OneChainWarning chain={activeWallet?.chain ?? MAIN_CHAIN} />

      {wallet.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading the wallet" />
      ) : needsSetup ? (
        <FinishSetup organizationId={company.organizationId} />
      ) : activeWallet ? (
        <WalletDetails wallet={activeWallet} />
      ) : (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(wallet.error)} />
          <Button
            label="Try again"
            loading={wallet.isFetching}
            onPress={() => void wallet.refetch()}
          />
        </View>
      )}

      {welcome ? (
        <Button
          label="Continue"
          variant="secondary"
          onPress={() => router.dismissTo("/")}
        />
      ) : null}
    </Screen>
  );
}

function OneChainWarning({ chain }: { chain: WalletChain }): JSX.Element {
  return (
    <View
      accessibilityRole="alert"
      className="gap-1 rounded-xl border border-amber-300 bg-amber-50 p-4"
    >
      <Text className="text-base font-semibold text-amber-900">
        Send USDC on {PAYEE_CHAIN_NAMES[chain]} only
      </Text>
      <Text className="text-sm text-amber-900">
        Other tokens, or USDC sent to this address on any other chain, can be
        lost for good. To send USDC from another chain, use Fund in from another
        chain.
      </Text>
    </View>
  );
}

function FinishSetup({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const finishSetup = useFinishWalletSetup(organizationId);
  const stillCreating = finishSetup.data?.status === "creating";

  return (
    <View className="gap-4">
      <View className="gap-1">
        <Text className="text-lg font-semibold text-gray-900">
          Your wallet isn’t ready yet
        </Text>
        <Text className="text-base text-gray-600">
          Setting it up didn’t finish. You can fund in once it’s done.
        </Text>
      </View>
      {stillCreating ? (
        <Text className="text-sm text-gray-600">
          Still setting up. Try again in a minute.
        </Text>
      ) : null}
      <ErrorMessage
        message={
          finishSetup.isError ? describeApiError(finishSetup.error) : null
        }
      />
      <Button
        label="Finish setting up wallet"
        loading={finishSetup.isPending}
        onPress={() => finishSetup.mutate()}
      />
    </View>
  );
}

function WalletDetails({ wallet }: { wallet: ActiveWallet }): JSX.Element {
  const router = useRouter();
  const chainName = PAYEE_CHAIN_NAMES[wallet.chain];
  const addressLabel =
    wallet.chain === "near" ? "NEAR account" : `${chainName} address`;
  return (
    <View className="gap-8">
      <View className="gap-3 rounded-2xl border border-gray-200 bg-white p-5">
        <View className="flex-row items-center gap-2">
          <Wallet size={18} color={colors.brandStrong} accessible={false} />
          <Text className="text-sm font-medium text-gray-600">
            Company wallet · {chainName}
          </Text>
        </View>
        <Text
          selectable
          className="text-3xl font-semibold leading-10 text-gray-900"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatUsdc(wallet.usdcBalance)} USDC
        </Text>
        <Text selectable className="text-sm leading-5 text-gray-600">
          {wallet.kesEquivalent
            ? `≈ KES ${formatKesCents(wallet.kesEquivalent.kesCents)} at ${wallet.kesEquivalent.rate} KES per USDC`
            : "KES rate unavailable"}
        </Text>
      </View>

      <View className="gap-3">
        <ListRow
          title="History"
          icon={History}
          subtitle="Deposits, payments, refunds and withdrawals"
          onPress={() => router.push("/wallet/history")}
        />
        <ListRow
          title="Fund in from another chain"
          icon={ArrowDownLeft}
          subtitle="Send USDC from Base, Ethereum, Arbitrum or Solana"
          onPress={() => router.push("/wallet/fund-in")}
        />
        <ListRow
          title="Withdraw"
          icon={ArrowUpRight}
          subtitle="Send USDC to an allowlisted address"
          onPress={() => router.push("/wallet/withdraw")}
        />
        <ListRow
          title="Withdrawal addresses"
          icon={MapPin}
          subtitle="The only addresses you can withdraw to"
          onPress={() => router.push("/wallet/addresses")}
        />
      </View>

      <View className="gap-4">
        <Text
          accessibilityRole="header"
          className="text-lg font-semibold text-gray-900"
        >
          Fund in · {addressLabel}
        </Text>
        <Text className="text-base text-gray-600">
          Send USDC on {chainName} to the company wallet from an exchange or
          another wallet.
        </Text>
        <View className="items-center rounded-2xl border border-gray-200 bg-white p-6">
          <QRCode value={wallet.address} size={180} />
        </View>
        <Text
          selectable
          accessibilityLabel={`${addressLabel} ${wallet.address}`}
          className="rounded-xl border border-gray-200 bg-white p-4 font-mono text-sm leading-5 text-gray-900"
        >
          {wallet.address}
        </Text>
        <CopyButton
          value={wallet.address}
          label="Copy address"
          failureMessage="Couldn’t copy the address. Select it and copy it instead."
        />
      </View>
    </View>
  );
}
