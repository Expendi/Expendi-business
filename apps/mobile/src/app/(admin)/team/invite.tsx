import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import type {
  InviteMemberResponse,
  MembershipRole,
} from "@expendi-business/shared";
import {
  inviteMemberRequestSchema,
  MEMBER_NAME_MAX_LENGTH,
  MEMBERSHIP_ROLES,
} from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "~/features/company/roles";
import { InstallLink } from "~/features/team/install-link";
import { memberDisplayName } from "~/features/team/member-summary";
import { useInviteMember } from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

const ROLE_OPTIONS: PickerOption<MembershipRole>[] = MEMBERSHIP_ROLES.map(
  (role) => ({
    value: role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
  }),
);

interface FieldErrors {
  email?: string;
  fullName?: string;
}

export default function InviteRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <InviteScreen company={company} />}
    </RequireAdmin>
  );
}

function InviteScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const invite = useInviteMember(company.organizationId);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<MembershipRole>("employee");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function handleSubmit(): void {
    const parsed = inviteMemberRequestSchema.safeParse({
      email,
      fullName,
      role,
    });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "email" || field === "fullName") && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    invite.mutate(parsed.data);
  }

  function inviteAnother(): void {
    setEmail("");
    setFullName("");
    setRole("employee");
    invite.reset();
  }

  if (invite.data) {
    return (
      <Screen belowHeader>
        <InviteResult result={invite.data} companyName={company.name} />
        <View className="gap-3">
          <Button label="Back to team" onPress={() => router.back()} />
          <Button
            label="Invite someone else"
            variant="ghost"
            onPress={inviteAnother}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen belowHeader>
      <View className="gap-4">
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="name@company.co.ke"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          editable={!invite.isPending}
        />
        <ErrorMessage message={fieldErrors.email ?? null} />

        <TextField
          label="Full name"
          value={fullName}
          onChangeText={setFullName}
          placeholder="As on their M-Pesa account"
          autoCapitalize="words"
          maxLength={MEMBER_NAME_MAX_LENGTH}
          editable={!invite.isPending}
        />
        <ErrorMessage message={fieldErrors.fullName ?? null} />

        <OptionPicker
          label="Role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={setRole}
          disabled={invite.isPending}
        />
      </View>

      <View className="gap-4">
        <ErrorMessage
          message={invite.isError ? describeApiError(invite.error) : null}
        />
        <Button
          label={role === "accountant" ? "Add accountant" : "Send invite"}
          loading={invite.isPending}
          onPress={handleSubmit}
        />
      </View>
    </Screen>
  );
}

function inviteOutcome(
  { member, emailSent, installUrl }: InviteMemberResponse,
  companyName: string,
): { title: string; body: string } {
  if (member.role === "accountant") {
    return {
      title: `${memberDisplayName(member)} is ${companyName}’s accountant`,
      body: "Accountants don’t sign in to the app. They’ll receive the monthly export by email.",
    };
  }
  const joins = `They’ll join ${companyName} when they sign in with ${member.email}.`;
  if (emailSent) {
    return {
      title: "Invite sent",
      body: `We emailed ${member.email} a link to install Expendi Business. ${joins}`,
    };
  }
  return {
    title: "Invite created, but the email didn’t send",
    body: installUrl ? `Share the install link yourself. ${joins}` : joins,
  };
}

function InviteResult({
  result,
  companyName,
}: {
  result: InviteMemberResponse;
  companyName: string;
}): JSX.Element {
  const { title, body } = inviteOutcome(result, companyName);
  const shareableLink =
    !result.emailSent && result.member.role !== "accountant"
      ? result.installUrl
      : null;

  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {title}
        </Text>
        <Text className="text-base text-gray-600">{body}</Text>
      </View>
      {shareableLink ? (
        <InstallLink
          url={shareableLink}
          inviteeEmail={result.member.email}
          companyName={companyName}
        />
      ) : null}
    </View>
  );
}
