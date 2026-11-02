import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import type { Payee, PayeeKind } from "@expendi-business/shared";
import {
  PAYEE_KINDS,
  PAYEE_NAME_MAX_LENGTH,
  updatePayeeRequestSchema,
} from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { Company } from "~/features/company/company-provider";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { DetailRowList } from "~/features/payees/detail-row-list";
import {
  CHANGE_WARNING,
  changedRecently,
  detailRows,
  KIND_LABELS,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import {
  useArchivePayee,
  useBankName,
  usePayee,
  useUpdatePayee,
} from "~/features/payees/use-payees";
import { memberDisplayName } from "~/features/team/member-summary";
import { useMembers } from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

const OTHER_KIND_OPTIONS: PickerOption<PayeeKind>[] = PAYEE_KINDS.filter(
  (kind) => kind !== "employee",
).map((kind) => ({ value: kind, label: KIND_LABELS[kind] }));

const dateTimeFormat = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default function PayeeRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PayeeScreen company={company} />}
    </RequireAdmin>
  );
}

function PayeeScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { payeeId } = useLocalSearchParams<{ payeeId: string }>();
  const payee = usePayee(company.organizationId, payeeId);

  if (payee.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading this payee" />
      </Screen>
    );
  }
  if (payee.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(payee.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={payee.isFetching}
          onPress={() => void payee.refetch()}
        />
        <Button
          label="Back to payees"
          variant="ghost"
          onPress={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={payee.isRefetching}
      onRefresh={() => void payee.refetch()}
    >
      <PayeeDetails
        organizationId={company.organizationId}
        payee={payee.data}
        asOf={payee.dataUpdatedAt}
      />
    </Screen>
  );
}

function PayeeDetails({
  organizationId,
  payee,
  asOf,
}: {
  organizationId: string;
  payee: Payee;
  asOf: number;
}): JSX.Element {
  const router = useRouter();
  const archive = useArchivePayee(organizationId, payee.id);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const recentlyChanged = changedRecently(payee.detailsChangedAt, asOf);

  function handleArchive(): void {
    archive.mutate(undefined, {
      onSuccess: () => setConfirmingArchive(false),
    });
  }

  return (
    <>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {payee.name}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Badge label={KIND_LABELS[payee.kind]} />
          {payee.archived ? <Badge label="Archived" /> : null}
          {recentlyChanged ? (
            <Badge label={RECENTLY_CHANGED_LABEL} tone="warning" />
          ) : null}
        </View>
      </View>

      {payee.membershipId ? (
        <LinkedMember
          organizationId={organizationId}
          membershipId={payee.membershipId}
        />
      ) : null}

      <PaymentDetails organizationId={organizationId} payee={payee} />

      {payee.archived ? (
        <Text className="text-base text-gray-600">
          This payee is archived. It can’t be paid or changed, and its history
          stays.
        </Text>
      ) : (
        <>
          <View className="gap-3">
            <Text className="text-sm font-medium text-amber-800">
              {CHANGE_WARNING}
            </Text>
            <Button
              label={
                payee.details ? "Change payment details" : "Add payment details"
              }
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/payees/[payeeId]/details",
                  params: { payeeId: payee.id },
                })
              }
            />
          </View>

          <EditPayee organizationId={organizationId} payee={payee} />

          <Button
            label="Archive payee"
            variant="danger"
            onPress={() => {
              archive.reset();
              setConfirmingArchive(true);
            }}
          />
        </>
      )}

      <ConfirmSheet
        visible={confirmingArchive}
        title={`Archive ${payee.name}?`}
        message="They won’t appear for new bills or payments. Payments already made to them stay in the history."
        confirmLabel="Archive"
        busy={archive.isPending}
        error={archive.isError ? describeApiError(archive.error) : null}
        onConfirm={handleArchive}
        onCancel={() => setConfirmingArchive(false)}
      />
    </>
  );
}

function LinkedMember({
  organizationId,
  membershipId,
}: {
  organizationId: string;
  membershipId: string;
}): JSX.Element {
  const members = useMembers(organizationId);
  const member = members.data?.find(
    (candidate) => candidate.id === membershipId,
  );

  return (
    <View className="gap-1">
      <Text className="text-sm font-medium text-gray-700">Team member</Text>
      {members.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading the team member" />
      ) : member ? (
        <>
          <Text className="text-base font-semibold text-gray-900">
            {memberDisplayName(member)}
          </Text>
          {member.name ? (
            <Text className="text-sm text-gray-600">{member.email}</Text>
          ) : null}
        </>
      ) : (
        <Text className="text-base text-gray-600">
          {members.isError
            ? describeApiError(members.error)
            : "No longer in the team."}
        </Text>
      )}
    </View>
  );
}

function PaymentDetails({
  organizationId,
  payee,
}: {
  organizationId: string;
  payee: Payee;
}): JSX.Element {
  const bankName = useBankName(organizationId, payee.details);

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Payment details
      </Text>
      {payee.details ? (
        <DetailRowList
          rows={detailRows(payee.details, {
            mask: true,
            bankName,
            payoutPhoneConfirmed: payee.payoutPhoneConfirmed,
          })}
        />
      ) : (
        <Text className="text-base text-gray-600">
          No payment details yet. Add them before paying this payee.
        </Text>
      )}
      {payee.detailsChangedAt ? (
        <Text className="text-sm text-gray-600">
          Last changed {dateTimeFormat.format(new Date(payee.detailsChangedAt))}
          .
        </Text>
      ) : null}
      {payee.secondConfirmationUntil ? (
        <Text className="text-sm text-amber-800">
          Paying them before{" "}
          {dateTimeFormat.format(new Date(payee.secondConfirmationUntil))} needs
          a second confirmation.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Name and kind change without a passkey. An employee payee stays linked
 * to its person, so its kind is fixed.
 */
function EditPayee({
  organizationId,
  payee,
}: {
  organizationId: string;
  payee: Payee;
}): JSX.Element {
  const update = useUpdatePayee(organizationId, payee.id);
  const [name, setName] = useState(payee.name);
  const [kind, setKind] = useState(payee.kind);
  const [error, setError] = useState<string | null>(null);
  const nameChanged = name.trim() !== payee.name;
  const kindChanged = kind !== payee.kind;

  function handleSave(): void {
    const parsed = updatePayeeRequestSchema.safeParse({
      ...(nameChanged ? { name } : {}),
      ...(kindChanged ? { kind } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the name and kind.");
      return;
    }
    setError(null);
    update.mutate(parsed.data);
  }

  return (
    <View className="gap-4">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Name and kind
      </Text>
      <TextField
        label="Payee name"
        value={name}
        onChangeText={(next) => {
          setName(next);
          update.reset();
        }}
        autoCapitalize="words"
        maxLength={PAYEE_NAME_MAX_LENGTH}
        editable={!update.isPending}
      />
      {payee.kind === "employee" ? (
        <Text className="text-sm text-gray-600">
          An employee payee stays an employee. To pay someone else, archive this
          payee and add a new one.
        </Text>
      ) : (
        <OptionPicker
          label="Kind"
          options={OTHER_KIND_OPTIONS}
          value={kind}
          onChange={(next) => {
            setKind(next);
            update.reset();
          }}
          disabled={update.isPending}
        />
      )}
      <ErrorMessage
        message={
          error ?? (update.isError ? describeApiError(update.error) : null)
        }
      />
      {update.isSuccess && !nameChanged && !kindChanged ? (
        <Text className="text-sm text-green-800">Saved.</Text>
      ) : null}
      <Button
        label="Save name and kind"
        variant="secondary"
        loading={update.isPending}
        disabled={!nameChanged && !kindChanged}
        onPress={handleSave}
      />
    </View>
  );
}
