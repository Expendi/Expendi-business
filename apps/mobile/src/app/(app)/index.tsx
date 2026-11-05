import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ArrowLeftRight, LogOut, Plus } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { MeResponse } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/button";
import { LoadingScreen } from "~/components/loading-screen";
import { Screen } from "~/components/screen";
import { Section } from "~/components/section";
import { SegmentedControl } from "~/components/segmented-control";
import { Text } from "~/components/text";
import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import { ROLE_LABELS } from "~/features/company/roles";
import { useMe } from "~/features/me/use-me";
import {
  AdminHomeContent,
  EmployeeHomeContent,
} from "~/features/overview/home-content";
import {
  QuickActions,
  WorkspaceNavigation,
} from "~/features/overview/workspace-navigation";
import { colors } from "~/theme/colors";

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
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const [tab, setTab] = useState<"overview" | "workspace">("overview");

  if (state.status !== "ready") {
    return <LoadingScreen label="Loading your company" />;
  }
  const { me, company, companies } = state;
  const hasOverview = company.role === "admin" || company.role === "employee";
  const showWorkspace = tab === "workspace" || !hasOverview;

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
      onRefresh={() => {
        void meQuery.refetch();
        void queryClient.invalidateQueries({
          queryKey: ["organizations", company.organizationId],
        });
      }}
    >
      <CompanyHeader
        company={company}
        canSwitch={companies.length > 1}
        onSwitch={() => router.push("/select-company")}
      />

      {hasOverview ? (
        <SegmentedControl
          label="Home sections"
          value={tab}
          options={[
            { value: "overview", label: "Overview" },
            { value: "workspace", label: "Workspace" },
          ]}
          onChange={setTab}
        />
      ) : null}

      {!showWorkspace ? (
        <QuickActions isAdmin={company.role === "admin"} />
      ) : null}

      {!showWorkspace && company.role === "admin" ? (
        <AdminHomeContent
          key={company.organizationId}
          organizationId={company.organizationId}
        />
      ) : !showWorkspace && company.role === "employee" ? (
        <EmployeeHomeContent
          key={company.organizationId}
          organizationId={company.organizationId}
        />
      ) : null}

      {showWorkspace ? (
        <>
          <WorkspaceNavigation isAdmin={company.role === "admin"} />
          <Account me={me} />

          <View className="gap-3">
            <Button
              label="Create another company"
              icon={Plus}
              variant="ghost"
              onPress={() => router.push("/create-company")}
            />
            <Button
              label="Sign out"
              icon={LogOut}
              variant="secondary"
              loading={signingOut}
              onPress={() => void handleSignOut()}
            />
          </View>
        </>
      ) : null}
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
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <BrandMark size={24} />
        <Text className="text-sm font-medium text-gray-600">
          Expendi Business
        </Text>
      </View>
      <Text
        accessibilityRole="header"
        className="text-2xl font-semibold leading-8 text-gray-900"
      >
        {company.name}
      </Text>
      <View className="flex-row flex-wrap items-center gap-3">
        <Badge label={ROLE_LABELS[company.role]} />
        {canSwitch ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-11 flex-row items-center justify-center gap-2"
            onPress={onSwitch}
          >
            <ArrowLeftRight
              size={16}
              color={colors.brandStrong}
              accessible={false}
            />
            <Text className="text-sm font-semibold text-brand-700">
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
    <Section title="Your account">
      <View className="gap-1">
        {me.user.fullName ? (
          <Text className="text-base font-semibold text-gray-900">
            {me.user.fullName}
          </Text>
        ) : null}
        <Text selectable className="text-sm text-gray-600">
          {me.user.email}
        </Text>
      </View>
      {me.memberships.map((membership) => (
        <View
          key={membership.id}
          className="flex-row items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3"
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
    </Section>
  );
}
