import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { MeResponse } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ListRow } from "~/components/list-row";
import { LoadingScreen } from "~/components/loading-screen";
import { Screen } from "~/components/screen";
import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import { ROLE_LABELS } from "~/features/company/roles";
import { useMe } from "~/features/me/use-me";

type Membership = MeResponse["memberships"][number];

const STATUS_LABELS: Record<Membership["status"], string> = {
  invited: "Invited",
  active: "Active",
  removed: "Removed",
};

export default function HomeScreen(): JSX.Element {
  const router = useRouter();
  const { signOut } = useAuth();
  const { state } = useCompanySession();
  const meQuery = useMe();
  const [signingOut, setSigningOut] = useState(false);

  if (state.status !== "ready") {
    return <LoadingScreen label="Loading your company" />;
  }
  const { me, company, companies } = state;

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Screen
      refreshing={meQuery.isRefetching}
      onRefresh={() => void meQuery.refetch()}
    >
      <CompanyHeader
        company={company}
        canSwitch={companies.length > 1}
        onSwitch={() => router.push("/select-company")}
      />

      <ListRow
        title="Claims"
        subtitle={
          company.role === "admin"
            ? "Everyone’s claims, and your own"
            : "Submit a receipt and get paid back"
        }
        onPress={() => router.push("/claims")}
      />

      <ListRow
        title="My salary payments"
        subtitle="Your pay from this company"
        onPress={() => router.push("/salary-payments")}
      />

      {company.role === "admin" ? (
        <View className="gap-3">
          <ListRow
            title="Approvals"
            subtitle="Claims waiting for you to approve and pay"
            onPress={() => router.push("/approvals")}
          />
          <ListRow
            title="Bills"
            subtitle="What’s due, overdue and paid"
            onPress={() => router.push("/bills")}
          />
          <ListRow
            title="Wallet"
            subtitle="Deposit USDC and see the balance"
            onPress={() => router.push("/wallet")}
          />
          <ListRow
            title="Team"
            subtitle="Invite people and manage roles"
            onPress={() => router.push("/team")}
          />
          <ListRow
            title="Payees"
            subtitle="Suppliers, subscriptions and others the company pays"
            onPress={() => router.push("/payees")}
          />
          <ListRow
            title="Payroll"
            subtitle="Salaries and payroll runs. Only admins see them."
            onPress={() => router.push("/payroll")}
          />
          <ListRow
            title="Company spending"
            subtitle="Spending already paid from the bank, card or cash"
            onPress={() => router.push("/spending")}
          />
        </View>
      ) : null}

      <Account me={me} />

      <View className="gap-3">
        <Button
          label="Create another company"
          variant="ghost"
          onPress={() => router.push("/create-company")}
        />
        <Button
          label="Sign out"
          variant="secondary"
          loading={signingOut}
          onPress={() => void handleSignOut()}
        />
      </View>
    </Screen>
  );
}

function CompanyHeader({
  company,
  canSwitch,
  onSwitch,
}: {
  company: Company;
  canSwitch: boolean;
  onSwitch: () => void;
}): JSX.Element {
  return (
    <View className="gap-2 pt-8">
      <Text
        accessibilityRole="header"
        className="text-3xl font-bold text-gray-900"
      >
        {company.name}
      </Text>
      <View className="flex-row items-center gap-3">
        <Badge label={ROLE_LABELS[company.role]} />
        {canSwitch ? (
          <Pressable accessibilityRole="button" hitSlop={12} onPress={onSwitch}>
            <Text className="text-sm font-semibold text-gray-900 underline">
              Switch company
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Account({ me }: { me: MeResponse }): JSX.Element {
  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Your account
      </Text>
      <View className="gap-1">
        {me.user.fullName ? (
          <Text className="text-base font-semibold text-gray-900">
            {me.user.fullName}
          </Text>
        ) : null}
        <Text className="text-base text-gray-600">{me.user.email}</Text>
      </View>
      {me.memberships.map((membership) => (
        <View
          key={membership.id}
          className="flex-row items-center justify-between rounded-xl border border-gray-200 px-4 py-3"
        >
          <View className="flex-1 gap-0.5">
            <Text className="text-base font-semibold text-gray-900">
              {membership.organizationName}
            </Text>
            <Text className="text-sm text-gray-600">
              {ROLE_LABELS[membership.role]}
            </Text>
          </View>
          <Text className="text-sm text-gray-500">
            {STATUS_LABELS[membership.status]}
          </Text>
        </View>
      ))}
    </View>
  );
}
