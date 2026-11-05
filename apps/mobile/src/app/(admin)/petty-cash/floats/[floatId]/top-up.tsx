import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { topUpFloatRequestSchema } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { useTopUpFloat } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function TopUpFloatRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <TopUpFloatScreen company={company} />}
    </RequireAdmin>
  );
}

/** How much more to send; the cost and the passkey follow (spec §6.22). */
function TopUpFloatScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { floatId } = useLocalSearchParams<{ floatId: string }>();
  const topUp = useTopUpFloat(company.organizationId, floatId);
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function submit(): void {
    const parsed = topUpFloatRequestSchema.safeParse({ amountKes: amount });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the amount.");
      return;
    }
    setFormError(null);
    topUp.mutate(
      { amountKes: amount },
      {
        onSuccess: (approval) =>
          router.replace({
            pathname: "/petty-cash/floats/[floatId]/pay",
            params: { floatId, movementId: approval.movement.id },
          }),
      },
    );
  }

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        The top-up is paid to their M-Pesa with your passkey, and adds to the
        float once it arrives.
      </Text>
      <TextField
        label="Amount (KES)"
        value={amount}
        onChangeText={setAmount}
        placeholder="5,000"
        keyboardType="decimal-pad"
      />
      <View className="gap-3">
        <ErrorMessage
          message={
            formError ?? (topUp.isError ? describeApiError(topUp.error) : null)
          }
        />
        <Button
          label="Review the payment"
          loading={topUp.isPending}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}
