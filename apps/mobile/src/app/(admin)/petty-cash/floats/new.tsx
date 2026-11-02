import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import type { Member } from "@expendi-business/shared";
import { issueFloatRequestSchema } from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  canHoldFloat,
  existingFloatId,
} from "~/features/petty-cash/float-display";
import { useIssueFloat } from "~/features/petty-cash/use-floats";
import { useMembers } from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

export default function IssueFloatRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <IssueFloatScreen company={company} />}
    </RequireAdmin>
  );
}

const memberOption = (member: Member): PickerOption<string> => ({
  value: member.id,
  label: member.name ?? member.email,
  description: member.name ? member.email : undefined,
});

/**
 * Issuing a float (spec §6.22): who holds it and how much, then the cost
 * and the admin's passkey on the next screen. Only people with a confirmed
 * M-Pesa number can be paid one.
 */
function IssueFloatScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const members = useMembers(company.organizationId);
  const issue = useIssueFloat(company.organizationId);
  const [membershipId, setMembershipId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const holders = members.data?.filter(canHoldFloat) ?? [];
  const openFloatId = existingFloatId(issue.error);
  const waiting = (members.data ?? []).filter(
    (member) =>
      member.status === "active" &&
      member.role !== "accountant" &&
      !member.payoutPhoneConfirmed,
  );

  function submit(): void {
    const parsed = issueFloatRequestSchema.safeParse({
      membershipId,
      amountKes: amount,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }
    setFormError(null);
    issue.mutate(
      { membershipId, amountKes: amount },
      {
        onSuccess: (approval) =>
          router.replace({
            pathname: "/petty-cash/floats/[floatId]/pay",
            params: {
              floatId: approval.float.id,
              movementId: approval.movement.id,
            },
          }),
      },
    );
  }

  return (
    <Screen belowHeader>
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
      ) : holders.length === 0 ? (
        <Text className="text-base text-gray-600">
          Nobody can hold a float yet. A float is paid to M-Pesa, so the person
          needs to confirm their M-Pesa number in the app first.
        </Text>
      ) : (
        <OptionPicker
          label="Who holds it?"
          options={holders.map(memberOption)}
          value={membershipId}
          onChange={setMembershipId}
        />
      )}
      {waiting.length > 0 ? (
        <Text className="text-sm text-gray-600">
          {waiting.map((member) => member.name ?? member.email).join(", ")}{" "}
          can’t hold a float until they confirm an M-Pesa number.
        </Text>
      ) : null}

      <TextField
        label="Amount (KES)"
        value={amount}
        onChangeText={setAmount}
        placeholder="10,000"
        keyboardType="decimal-pad"
      />

      <View className="gap-3">
        <ErrorMessage
          message={
            formError ?? (issue.isError ? describeApiError(issue.error) : null)
          }
        />
        {openFloatId ? (
          <Button
            label="Open their float"
            variant="secondary"
            onPress={() =>
              router.replace({
                pathname: "/petty-cash/floats/[floatId]",
                params: { floatId: openFloatId },
              })
            }
          />
        ) : null}
        <Button
          label="Review the payment"
          loading={issue.isPending}
          disabled={holders.length === 0}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}
