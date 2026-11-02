import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import type { ActiveWallet } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { CopyButton } from "~/components/copy-button";
import { ErrorMessage } from "~/components/error-message";
import { ListRow } from "~/components/list-row";
import { Screen } from "~/components/screen";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  isMissingWallet,
  useCompanyWallet,
  useFinishWalletSetup,
} from "~/features/wallet/use-company-wallet";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatUsdc } from "~/lib/money";

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
            Deposit USDC to start paying claims.
          </Text>
        </View>
      ) : null}

      <BaseOnlyWarning />

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

function BaseOnlyWarning(): JSX.Element {
  return (
    <View
      accessibilityRole="alert"
      className="gap-1 rounded-2xl border-2 border-amber-500 bg-amber-50 p-4"
    >
      <Text className="text-lg font-bold text-amber-900">
        Send USDC on Base only
      </Text>
      <Text className="text-sm text-amber-900">
        Other tokens, or USDC sent on any other network, can be lost for good.
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
          Setting it up didn’t finish. You can deposit once it’s done.
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
  return (
    <View className="gap-8">
      <View className="gap-1">
        <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Balance
        </Text>
        <Text className="text-3xl font-bold text-gray-900">
          {formatUsdc(wallet.usdcBalance)} USDC
        </Text>
        <Text className="text-base text-gray-600">
          {wallet.kesEquivalent
            ? `≈ KES ${formatKesCents(wallet.kesEquivalent.kesCents)} at ${wallet.kesEquivalent.rate} KES per USDC`
            : "KES rate unavailable"}
        </Text>
      </View>

      <View className="gap-3">
        <ListRow
          title="History"
          subtitle="Deposits, payments, refunds and withdrawals"
          onPress={() => router.push("/wallet/history")}
        />
        <ListRow
          title="Withdraw"
          subtitle="Send USDC to an allowlisted address"
          onPress={() => router.push("/wallet/withdraw")}
        />
        <ListRow
          title="Withdrawal addresses"
          subtitle="The only addresses you can withdraw to"
          onPress={() => router.push("/wallet/addresses")}
        />
      </View>

      <View className="gap-4">
        <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Deposit address · Base
        </Text>
        <View className="items-center rounded-2xl border border-gray-200 p-6">
          <QRCode value={wallet.address} size={180} />
        </View>
        <Text
          selectable
          accessibilityLabel={`Deposit address ${wallet.address}`}
          className="rounded-xl bg-gray-50 p-4 font-mono text-sm text-gray-900"
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
