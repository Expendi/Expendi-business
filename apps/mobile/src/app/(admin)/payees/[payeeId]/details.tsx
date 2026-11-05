import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  Payee,
  PayeeChangeChallenge,
  PayeeMethod,
} from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
} from "~/features/payees/payee-fields";
import type { PayeeChangeRequest } from "~/features/payees/use-payees";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { ApprovalPasskeyGate } from "~/features/approval";
import { RequireAdmin } from "~/features/company/require-admin";
import { PayeeChangeReview } from "~/features/payees/payee-change-review";
import { PayeeDetailsFields } from "~/features/payees/payee-details-fields";
import { CHANGE_WARNING } from "~/features/payees/payee-display";
import {
  detailsToValues,
  validateDetails,
} from "~/features/payees/payee-fields";
import { usePayee, useRequestPayeeChange } from "~/features/payees/use-payees";
import { describeApiError } from "~/lib/api";

export default function ChangePayeeDetailsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <Screen belowHeader>
          <ApprovalPasskeyGate>
            <ChangeDetailsScreen organizationId={company.organizationId} />
          </ApprovalPasskeyGate>
        </Screen>
      )}
    </RequireAdmin>
  );
}

function ChangeDetailsScreen({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const router = useRouter();
  const { payeeId } = useLocalSearchParams<{ payeeId: string }>();
  const payee = usePayee(organizationId, payeeId);

  if (payee.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading this payee" />;
  }
  if (payee.isError) {
    return (
      <View className="gap-4">
        <ErrorMessage message={describeApiError(payee.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={payee.isFetching}
          onPress={() => void payee.refetch()}
        />
      </View>
    );
  }
  if (payee.data.archived) {
    return (
      <View className="gap-4">
        <Text className="text-base text-gray-600">
          {payee.data.name} is archived, so their payment details can’t change.
        </Text>
        <Button
          label="Back"
          variant="secondary"
          onPress={() => router.back()}
        />
      </View>
    );
  }
  return (
    <ChangeDetailsFlow organizationId={organizationId} payee={payee.data} />
  );
}

interface PendingReview {
  readonly request: PayeeChangeRequest;
  readonly challenge: PayeeChangeChallenge;
}

function ChangeDetailsFlow({
  organizationId,
  payee,
}: {
  organizationId: string;
  payee: Payee;
}): JSX.Element {
  const router = useRouter();
  const request = useRequestPayeeChange(organizationId);
  const [method, setMethod] = useState<PayeeMethod>(
    payee.details?.method ?? "mpesa_phone",
  );
  const [values, setValues] = useState(() => detailsToValues(payee.details));
  const [errors, setErrors] = useState<DetailFieldErrors>({});
  const [review, setReview] = useState<PendingReview | null>(null);
  const [saved, setSaved] = useState(false);

  if (saved) {
    return (
      <View className="gap-6">
        <View className="gap-2">
          <Text
            accessibilityRole="header"
            className="text-2xl font-bold text-gray-900"
          >
            Payment details changed
          </Text>
          <Text className="text-base text-gray-600">
            Every admin was emailed. Paying {payee.name} in the next 24 hours
            needs a second confirmation.
          </Text>
        </View>
        <Button label="Done" onPress={() => router.back()} />
      </View>
    );
  }

  if (review) {
    return (
      <PayeeChangeReview
        organizationId={organizationId}
        request={review.request}
        challenge={review.challenge}
        currentPayee={payee}
        memberName={null}
        payoutPhoneConfirmed={payee.payoutPhoneConfirmed}
        onEdit={() => setReview(null)}
        onConfirmed={() => setSaved(true)}
      />
    );
  }

  function changeValue(field: DetailField, value: string): void {
    setValues({ ...values, [field]: value });
  }

  function handleReview(): void {
    const details = validateDetails(method, payee.kind, values);
    if (!details.ok) {
      setErrors(details.errors);
      return;
    }
    setErrors({});
    const change: PayeeChangeRequest = {
      action: "change_details",
      payeeId: payee.id,
      details: details.details,
    };
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "confirmation_required") {
          setReview({ request: change, challenge: response });
        }
      },
    });
  }

  return (
    <View className="gap-8">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {payee.details ? "Change payment details" : "Add payment details"}
        </Text>
        <Text className="text-base text-gray-600">For {payee.name}.</Text>
        <Text className="text-sm font-medium text-amber-800">
          {CHANGE_WARNING}
        </Text>
      </View>

      <PayeeDetailsFields
        organizationId={organizationId}
        kind={payee.kind}
        method={method}
        onMethodChange={(next) => {
          setMethod(next);
          request.reset();
        }}
        values={values}
        onValueChange={changeValue}
        errors={errors}
        disabled={request.isPending}
        payoutPhoneConfirmed={payee.payoutPhoneConfirmed}
      />

      <ErrorMessage
        message={request.isError ? describeApiError(request.error) : null}
      />
      <Button
        label="Review"
        loading={request.isPending}
        onPress={handleReview}
      />
    </View>
  );
}
