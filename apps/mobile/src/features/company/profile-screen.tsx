import type { JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ReceiptText } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import type { MeResponse } from "@expendi-business/shared";

import { Avatar } from "~/components/avatar";
import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup } from "~/components/soft-group";
import { TabScreen } from "~/components/tab-screen";
import { Text } from "~/components/text";
import { AccountSection } from "./account-section";
import { CompanyCard } from "./company-card";
import type { Company } from "./company-provider";

/** The employee's and accountant's Profile tab. */
export function ProfileScreen({
  me,
  company,
  canSwitch,
  onSignOut,
}: {
  me: MeResponse;
  company: Company;
  canSwitch: boolean;
  onSignOut: () => Promise<void>;
}): JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const name = me.user.fullName ?? me.user.email;

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <TabScreen
      title="Profile"
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    >
      <View
        accessible
        accessibilityLabel={[name, me.user.email, me.user.phone]
          .filter(Boolean)
          .join(", ")}
        className="flex-row items-center gap-4 rounded-3xl bg-gray-50 p-4"
      >
        <Avatar name={name} size={56} />
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={2}
            className="text-[18px] font-semibold leading-6 text-gray-900"
          >
            {name}
          </Text>
          {me.user.fullName ? (
            <Text selectable className="text-[14px] leading-5 text-gray-600">
              {me.user.email}
            </Text>
          ) : null}
          {me.user.phone ? (
            <Text selectable className="text-[14px] leading-5 text-gray-600">
              {me.user.phone}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="mt-4">
        <CompanyCard company={company} canSwitch={canSwitch} />
      </View>

      <View className="mt-7">
        <SectionHeader title="Your work" />
        <SoftGroup>
          <ItemRow
            title="My reimbursements"
            meta="Receipts you’ve sent and what’s been paid"
            icon={ReceiptText}
            onPress={() => router.push("/claims")}
          />
        </SoftGroup>
      </View>

      <View className="mt-7">
        <AccountSection me={me} showPerson={false} onSignOut={onSignOut} />
      </View>
    </TabScreen>
  );
}
