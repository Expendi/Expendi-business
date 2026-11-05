import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  CreatePayeeRequest,
  Member,
  MembersResponse,
  Payee,
  PayeeChangeChallenge,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  createPayeeRequestSchema,
  PAYEE_KINDS,
  PAYEE_NAME_MAX_LENGTH,
} from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type {
  DetailField,
  DetailFieldErrors,
} from "~/features/payees/payee-fields";
import type { PayeeChangeRequest } from "~/features/payees/use-payees";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { ApprovalPasskeyGate } from "~/features/approval";
import { RequireAdmin } from "~/features/company/require-admin";
import { PayeeChangeReview } from "~/features/payees/payee-change-review";
import { PayeeDetailsFields } from "~/features/payees/payee-details-fields";
import {
  KIND_DESCRIPTIONS,
  KIND_LABELS,
} from "~/features/payees/payee-display";
import {
  EMPTY_DETAIL_VALUES,
  methodsForKind,
  validateDetails,
} from "~/features/payees/payee-fields";
import { usePayees, useRequestPayeeChange } from "~/features/payees/use-payees";
import { memberDisplayName } from "~/features/team/member-summary";
import { useMembers } from "~/features/team/use-members";
import { describeApiError } from "~/lib/api";

const KIND_OPTIONS: PickerOption<PayeeKind>[] = PAYEE_KINDS.map((kind) => ({
  value: kind,
  label: KIND_LABELS[kind],
  description: KIND_DESCRIPTIONS[kind],
}));

export default function NewPayeeRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <ApprovalPasskeyGate>
            <NewPayeeFlow organizationId={company.organizationId} />
          </ApprovalPasskeyGate>
        </Screen>
      )}
    </RequireAdmin>
  );
}

interface PendingReview {
  readonly request: PayeeChangeRequest;
  readonly challenge: PayeeChangeChallenge;
}

interface FormErrors {
  name?: string;
  membershipId?: string;
  details: DetailFieldErrors;
}

function NewPayeeFlow({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const router = useRouter();
  const members = useMembers(organizationId);
  const employeePayees = usePayees(organizationId, {
    kind: "employee",
    method: null,
    archived: false,
  });
  const request = useRequestPayeeChange(organizationId);
  const [kind, setKind] = useState<PayeeKind>("supplier");
  const [membershipId, setMembershipId] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState<PayeeMethod>("mpesa_phone");
  const [values, setValues] = useState(EMPTY_DETAIL_VALUES);
  const [errors, setErrors] = useState<FormErrors>({ details: {} });
  const [review, setReview] = useState<PendingReview | null>(null);

  const member = members.data?.find(
    (candidate) => candidate.id === membershipId,
  );
  const employee = kind === "employee";
  const busy = request.isPending;

  function openPayee(payee: Payee): void {
    router.replace({
      pathname: "/payees/[payeeId]",
      params: { payeeId: payee.id },
    });
  }

  if (review) {
    return (
      <PayeeChangeReview
        organizationId={organizationId}
        request={review.request}
        challenge={review.challenge}
        currentPayee={null}
        memberName={member ? memberDisplayName(member) : null}
        payoutPhoneConfirmed={member?.payoutPhoneConfirmed ?? null}
        onEdit={() => setReview(null)}
        onConfirmed={openPayee}
      />
    );
  }

  function changeKind(next: PayeeKind): void {
    setKind(next);
    request.reset();
    if (next !== "employee") setMembershipId("");
    if (!methodsForKind(next).includes(method)) setMethod("mpesa_phone");
  }

  function chooseMember(chosen: Member): void {
    setMembershipId(chosen.id);
    request.reset();
    if (name.trim() === "" && chosen.name) setName(chosen.name);
    if (values.accountName.trim() === "" && chosen.name) {
      setValues({ ...values, accountName: chosen.name });
    }
  }

  function changeValue(field: DetailField, value: string): void {
    setValues({ ...values, [field]: value });
  }

  function handleReview(): void {
    const parsedName = createPayeeRequestSchema.shape.name.safeParse(name);
    const details = validateDetails(method, kind, values);
    const memberError =
      employee && membershipId === "" ? "Choose the employee." : undefined;
    if (!parsedName.success || !details.ok || memberError) {
      setErrors({
        name: parsedName.error?.issues[0]?.message,
        membershipId: memberError,
        details: details.ok ? {} : details.errors,
      });
      return;
    }
    setErrors({ details: {} });

    const payee: CreatePayeeRequest = employee
      ? { kind, name: parsedName.data, membershipId, details: details.details }
      : { kind, name: parsedName.data, details: details.details };
    const change: PayeeChangeRequest = { action: "create", payee };
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "created") openPayee(response.payee);
        else setReview({ request: change, challenge: response });
      },
    });
  }

  return (
    <View className="gap-8">
      <OptionPicker
        label="Who is this payee?"
        options={KIND_OPTIONS}
        value={kind}
        onChange={changeKind}
        disabled={busy}
      />

      {employee ? (
        <EmployeePicker
          members={members}
          employeePayees={employeePayees}
          membershipId={membershipId}
          onChoose={chooseMember}
          error={errors.membershipId ?? null}
          disabled={busy}
        />
      ) : null}

      <View className="gap-2">
        <TextField
          label="Payee name"
          value={name}
          onChangeText={setName}
          placeholder={employee ? "Their full name" : "e.g. Kenya Power"}
          autoCapitalize="words"
          maxLength={PAYEE_NAME_MAX_LENGTH}
          editable={!busy}
        />
        <ErrorMessage message={errors.name ?? null} />
      </View>

      <PayeeDetailsFields
        organizationId={organizationId}
        kind={kind}
        method={method}
        onMethodChange={(next) => {
          setMethod(next);
          request.reset();
        }}
        values={values}
        onValueChange={changeValue}
        errors={errors.details}
        disabled={busy}
        payoutPhoneConfirmed={member?.payoutPhoneConfirmed ?? null}
      />

      <ErrorMessage
        message={request.isError ? describeApiError(request.error) : null}
      />
      <Button
        label={method === "outside" ? "Add payee" : "Review"}
        loading={busy}
        onPress={handleReview}
      />
    </View>
  );
}

/**
 * Anyone in the team who can log in; accountants can't be paid, and each
 * person has at most one active payee.
 */
function EmployeePicker({
  members,
  employeePayees,
  membershipId,
  onChoose,
  error,
  disabled,
}: {
  members: UseQueryResult<MembersResponse>;
  employeePayees: UseQueryResult<Payee[]>;
  membershipId: string;
  onChoose: (member: Member) => void;
  error: string | null;
  disabled: boolean;
}): JSX.Element {
  if (members.isPending || employeePayees.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the team" />;
  }
  if (members.isError || employeePayees.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage
          message={describeApiError(members.error ?? employeePayees.error)}
        />
        <Button
          label="Try again"
          variant="secondary"
          onPress={() => {
            void members.refetch();
            void employeePayees.refetch();
          }}
        />
      </View>
    );
  }

  const alreadyPayees = new Set(
    employeePayees.data.map((payee) => payee.membershipId),
  );
  const eligible = members.data.filter(
    (candidate) =>
      candidate.role !== "accountant" && !alreadyPayees.has(candidate.id),
  );
  if (eligible.length === 0) {
    return (
      <Text className="text-base text-gray-600">
        Everyone in the team is already a payee. Invite someone under Team to
        add them.
      </Text>
    );
  }

  const options: PickerOption<string>[] = eligible.map((candidate) => ({
    value: candidate.id,
    label: memberDisplayName(candidate),
    description: `${candidate.email} · ${candidate.payoutPhoneConfirmed ? "M-Pesa number confirmed" : "No M-Pesa number yet"}`,
  }));

  return (
    <View className="gap-2">
      <OptionPicker
        label="Team member"
        options={options}
        value={membershipId}
        disabled={disabled}
        onChange={(id) => {
          const chosen = eligible.find((candidate) => candidate.id === id);
          if (chosen) onChoose(chosen);
        }}
      />
      <ErrorMessage message={error} />
    </View>
  );
}
