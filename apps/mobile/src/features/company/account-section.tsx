import type { JSX } from "react";
import { useRouter } from "expo-router";
import { Building2, Plus } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import type { MeResponse } from "@expendi-business/shared";

import { SectionHeader } from "~/components/section-header";
import { ItemRow, SoftGroup } from "~/components/soft-group";
import { Text } from "~/components/text";
import { colors } from "~/theme/colors";
import { ROLE_LABELS } from "./roles";

type Membership = MeResponse["memberships"][number];

const STATUS_LABELS: Record<Membership["status"], string> = {
  invited: "Invited",
  active: "Active",
  removed: "Removed",
};

/**
 * Account: who is signed in (unless the screen already shows them), every
 * membership with its role and status, a way to start another company, and
 * Sign out.
 */
export function AccountSection({
  me,
  showPerson,
  onSignOut,
}: {
  me: MeResponse;
  showPerson: boolean;
  onSignOut: () => Promise<void>;
}): JSX.Element {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <View>
      <SectionHeader title="Account" />
      {showPerson ? (
        <View className="mb-3 rounded-3xl bg-gray-50 px-4 py-3">
          {me.user.fullName ? (
            <Text className="text-[16px] font-semibold text-gray-900">
              {me.user.fullName}
            </Text>
          ) : null}
          <Text selectable className="text-[14px] leading-5 text-gray-600">
            {me.user.email}
          </Text>
        </View>
      ) : null}
      <SoftGroup>
        {me.memberships.map((membership) => (
          <ItemRow
            key={membership.id}
            title={membership.organizationName}
            meta={ROLE_LABELS[membership.role]}
            value={STATUS_LABELS[membership.status]}
            icon={Building2}
            iconTone="neutral"
          />
        ))}
        <ItemRow
          title="Create another company"
          icon={Plus}
          onPress={() => router.push("/create-company")}
        />
      </SoftGroup>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        accessibilityState={{ busy: signingOut, disabled: signingOut }}
        disabled={signingOut}
        onPress={() => void signOut()}
        className="mt-5 min-h-14 items-center justify-center rounded-2xl bg-gray-50 active:opacity-80"
      >
        {signingOut ? (
          <ActivityIndicator color={colors.error} />
        ) : (
          <Text className="text-[17px] font-semibold text-error-700">
            Sign out
          </Text>
        )}
      </Pressable>
    </View>
  );
}
