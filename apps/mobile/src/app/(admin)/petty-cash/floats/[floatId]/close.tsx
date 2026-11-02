import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import {
  closeFloatRequestSchema,
  FLOAT_NOTE_MAX_LENGTH,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { holderName, kes } from "~/features/petty-cash/float-display";
import { useCloseFloat, useFloat } from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function CloseFloatRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <CloseFloatScreen company={company} />}
    </RequireAdmin>
  );
}

/**
 * Closing a float (spec §6.22). It closes once nothing is left on it; with
 * money still on it, the admin writes the rest off by saying why.
 */
function CloseFloatScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { floatId } = useLocalSearchParams<{ floatId: string }>();
  const float = useFloat(company.organizationId, floatId);
  const close = useCloseFloat(company.organizationId, floatId);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (float.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the float" />
      </Screen>
    );
  }
  if (float.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(float.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={float.isFetching}
          onPress={() => void float.refetch()}
        />
      </Screen>
    );
  }

  const left = float.data.leftKes;
  const writesOff = left !== "0";

  function submit(): void {
    const request = writesOff ? { writeOffReason: reason } : {};
    const parsed = closeFloatRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Say why.");
      return;
    }
    setFormError(null);
    close.mutate(request, { onSuccess: () => router.back() });
  }

  return (
    <Screen belowHeader>
      {writesOff ? (
        <View className="gap-2">
          <Text className="text-lg font-bold text-gray-900">
            {kes(left)} is still with {holderName(float.data)}
          </Text>
          <Text className="text-base text-gray-600">
            Record what they hand back first. If it isn’t coming back, say why
            and it’s written off as you close the float.
          </Text>
          <Button
            label="Record cash handed back"
            variant="secondary"
            onPress={() =>
              router.replace({
                pathname: "/petty-cash/floats/[floatId]/return",
                params: { floatId },
              })
            }
          />
          <TextField
            label="Why it isn’t coming back"
            value={reason}
            onChangeText={setReason}
            placeholder="Cash box lost in the office move"
            multiline
            maxLength={FLOAT_NOTE_MAX_LENGTH}
          />
        </View>
      ) : (
        <Text className="text-base text-gray-600">
          Nothing is left on this float. Closing it stops any more spending from
          it. A payment still waiting for approval is cancelled.
        </Text>
      )}
      <View className="gap-3">
        <ErrorMessage
          message={
            formError ?? (close.isError ? describeApiError(close.error) : null)
          }
        />
        <Button
          label={writesOff ? `Write off ${kes(left)} and close` : "Close"}
          variant={writesOff ? "danger" : "primary"}
          loading={close.isPending}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}
