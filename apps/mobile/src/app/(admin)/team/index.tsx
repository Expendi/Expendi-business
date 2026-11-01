import type { JSX } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Member } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { useCompanySession } from "~/features/company/company-provider";
import { RequireAdmin } from "~/features/company/require-admin";
import { ROLE_LABELS } from "~/features/company/roles";
import {
  MemberBadges,
  memberDisplayName,
} from "~/features/team/member-summary";
import { useMembers } from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

export default function TeamRoute(): JSX.Element {
  return (
    <RequireAdmin>{(company) => <TeamScreen company={company} />}</RequireAdmin>
  );
}

function TeamScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { state } = useCompanySession();
  const members = useMembers(company.organizationId);
  const currentEmail = state.status === "ready" ? state.me.user.email : null;

  return (
    <Screen
      belowHeader
      refreshing={members.isRefetching}
      onRefresh={() => void members.refetch()}
    >
      <Button
        label="Invite someone"
        onPress={() => router.push("/team/invite")}
      />

      {members.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading the team" />
      ) : members.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(members.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={members.isFetching}
            onPress={() => void members.refetch()}
          />
        </View>
      ) : (
        <View className="gap-3">
          {members.data.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isYou={member.email === currentEmail}
              onPress={() =>
                router.push({
                  pathname: "/team/[membershipId]",
                  params: { membershipId: member.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function MemberRow({
  member,
  isYou,
  onPress,
}: {
  member: Member;
  isYou: boolean;
  onPress: () => void;
}): JSX.Element {
  const name = memberDisplayName(member);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${ROLE_LABELS[member.role]}`}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900">
            {name}
            {isYou ? " (you)" : ""}
          </Text>
          {member.name ? (
            <Text className="text-sm text-gray-600">{member.email}</Text>
          ) : null}
        </View>
        <Text className="text-sm font-medium text-gray-700">
          {ROLE_LABELS[member.role]}
        </Text>
      </View>
      <MemberBadges member={member} />
    </Pressable>
  );
}
