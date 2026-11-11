import type { JSX } from "react";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";

import { CappedText, Text } from "~/components/text";
import { initialsOf } from "~/lib/initials";
import type { Company } from "./company-provider";
import { companyCardMeta } from "./company-display";
import { ROLE_LABELS } from "./roles";

/**
 * The coral-50 card at the top of Company and Profile: company initials,
 * name, the person's role, and Switch when they belong to more than one.
 */
export function CompanyCard({
  company,
  memberCount = null,
  canSwitch,
}: {
  company: Company;
  /** Active members; only admins can read the list. */
  memberCount?: number | null;
  canSwitch: boolean;
}): JSX.Element {
  const router = useRouter();
  return (
    <View className="flex-row items-center gap-4 rounded-3xl bg-brand-50 p-4">
      <View
        accessible={false}
        className="h-14 w-14 items-center justify-center rounded-2xl bg-brand-500"
      >
        <CappedText
          size={18}
          maxScale={1.2}
          className="font-semibold text-gray-900"
        >
          {initialsOf(company.name)}
        </CappedText>
      </View>
      <View
        accessible
        accessibilityLabel={`${company.name}, ${companyCardMeta(ROLE_LABELS[company.role], memberCount)}`}
        className="min-w-0 flex-1"
      >
        <Text
          numberOfLines={2}
          className="text-[18px] font-semibold leading-6 text-gray-900"
        >
          {company.name}
        </Text>
        <Text className="text-[14px] leading-5 text-gray-600">
          {companyCardMeta(ROLE_LABELS[company.role], memberCount)}
        </Text>
      </View>
      {canSwitch ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch company"
          onPress={() => router.push("/select-company")}
          className="min-h-10 items-center justify-center rounded-full bg-white px-4 active:opacity-80"
        >
          <Text className="text-[14px] font-semibold text-gray-900">Switch</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
