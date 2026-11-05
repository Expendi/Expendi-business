import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { AssignableRole, Member } from "@expendi-business/shared";
import { ASSIGNABLE_ROLES } from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { useCompanySession } from "~/features/company/company-provider";
import { RequireAdmin } from "~/features/company/require-admin";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "~/features/company/roles";
import { InstallLink } from "~/features/team/install-link";
import {
  MemberBadges,
  memberDisplayName,
} from "~/features/team/member-summary";
import {
  useChangeMemberRole,
  useInviteMember,
  useMembers,
  useRemoveMember,
} from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

const ASSIGNABLE_ROLE_OPTIONS: PickerOption<AssignableRole>[] =
  ASSIGNABLE_ROLES.map((role) => ({
    value: role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
  }));

export default function MemberRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <MemberScreen company={company} />}
    </RequireAdmin>
  );
}

function MemberScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { membershipId } = useLocalSearchParams<{ membershipId: string }>();
  const members = useMembers(company.organizationId);
  const member = members.data?.find(
    (candidate) => candidate.id === membershipId,
  );

  if (members.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading this person" />
      </Screen>
    );
  }
  if (!member) {
    return (
      <Screen belowHeader>
        <ErrorMessage
          message={
            members.isError
              ? describeApiError(members.error)
              : "This person is no longer in the team."
          }
        />
        <Button label="Back to team" onPress={() => router.back()} />
      </Screen>
    );
  }
  return <MemberDetails company={company} member={member} />;
}

function removalMessage({
  member,
  name,
  isYou,
  companyName,
}: {
  member: Member;
  name: string;
  isYou: boolean;
  companyName: string;
}): string {
  if (isYou) return `You’ll lose access to ${companyName} straight away.`;
  if (member.status === "invited") {
    return `${name}’s invite is cancelled. Signing in with ${member.email} won’t add them to ${companyName}.`;
  }
  return `${name} loses access to ${companyName} straight away. Claims they’ve already submitted can still be paid.`;
}

function MemberDetails({
  company,
  member,
}: {
  company: Company;
  member: Member;
}): JSX.Element {
  const router = useRouter();
  const { state } = useCompanySession();
  const changeRole = useChangeMemberRole(company.organizationId);
  const removeMember = useRemoveMember(company.organizationId);
  const [role, setRole] = useState<AssignableRole>(
    member.role === "admin" ? "admin" : "employee",
  );
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const isYou =
    state.status === "ready" && state.me.user.email === member.email;
  const name = memberDisplayName(member);

  function handleRemove(): void {
    removeMember.mutate(member.id, {
      onSuccess: () => {
        setConfirmingRemoval(false);
        if (!isYou) router.back();
      },
    });
  }

  function cancelRemoval(): void {
    setConfirmingRemoval(false);
    removeMember.reset();
  }

  return (
    <Screen belowHeader>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {name}
          {isYou ? " (you)" : ""}
        </Text>
        {member.name ? (
          <Text className="text-base text-gray-600">{member.email}</Text>
        ) : null}
        <MemberBadges member={member} />
      </View>

      {member.role === "accountant" ? (
        <View className="gap-1">
          <Text className="text-sm font-medium text-gray-700">Role</Text>
          <Text className="text-base font-semibold text-gray-900">
            {ROLE_LABELS.accountant}
          </Text>
          <Text className="text-sm text-gray-600">
            {ROLE_DESCRIPTIONS.accountant}
          </Text>
        </View>
      ) : (
        <View className="gap-4">
          <OptionPicker
            label="Role"
            options={ASSIGNABLE_ROLE_OPTIONS}
            value={role}
            onChange={(next) => {
              setRole(next);
              changeRole.reset();
            }}
            disabled={changeRole.isPending}
          />
          <ErrorMessage
            message={
              changeRole.isError ? describeApiError(changeRole.error) : null
            }
          />
          {changeRole.isSuccess && role === member.role ? (
            <Text className="text-sm text-gray-600">
              {name} is now {ROLE_LABELS[role].toLowerCase()}.
            </Text>
          ) : null}
          <Button
            label="Change role"
            variant="secondary"
            loading={changeRole.isPending}
            disabled={role === member.role}
            onPress={() => changeRole.mutate({ membershipId: member.id, role })}
          />
        </View>
      )}

      {member.status === "invited" &&
      member.role !== "accountant" &&
      member.name ? (
        <ResendInvite
          organizationId={company.organizationId}
          companyName={company.name}
          member={member}
          fullName={member.name}
        />
      ) : null}

      <Button
        label={`Remove ${isYou ? "yourself" : name}`}
        variant="danger"
        onPress={() => setConfirmingRemoval(true)}
      />

      <ConfirmSheet
        visible={confirmingRemoval}
        title={`Remove ${name}?`}
        message={removalMessage({
          member,
          name,
          isYou,
          companyName: company.name,
        })}
        confirmLabel="Remove"
        busy={removeMember.isPending}
        error={
          removeMember.isError ? describeApiError(removeMember.error) : null
        }
        onConfirm={handleRemove}
        onCancel={cancelRemoval}
      />
    </Screen>
  );
}

/** Inviting someone who is still invited sends the install email again. */
function ResendInvite({
  organizationId,
  companyName,
  member,
  fullName,
}: {
  organizationId: string;
  companyName: string;
  member: Member;
  fullName: string;
}): JSX.Element {
  const resend = useInviteMember(organizationId);

  return (
    <View className="gap-3">
      <ErrorMessage
        message={resend.isError ? describeApiError(resend.error) : null}
      />
      {resend.data?.emailSent ? (
        <Text className="text-sm text-gray-600">
          We emailed {member.email} the install link again.
        </Text>
      ) : null}
      {resend.data && !resend.data.emailSent ? (
        <View className="gap-3">
          <Text className="text-sm text-gray-600">
            {resend.data.installUrl
              ? "The email didn’t send. Share the install link yourself."
              : "The email didn’t send."}
          </Text>
          {resend.data.installUrl ? (
            <InstallLink
              url={resend.data.installUrl}
              inviteeEmail={member.email}
              companyName={companyName}
            />
          ) : null}
        </View>
      ) : null}
      <Button
        label="Resend invite email"
        variant="secondary"
        loading={resend.isPending}
        onPress={() =>
          resend.mutate({ email: member.email, fullName, role: member.role })
        }
      />
    </View>
  );
}
