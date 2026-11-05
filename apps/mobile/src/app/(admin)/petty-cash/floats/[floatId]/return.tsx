import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import {
  FLOAT_NOTE_MAX_LENGTH,
  recordFloatReturnRequestSchema,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { kes } from "~/features/petty-cash/float-display";
import {
  useFloat,
  useRecordFloatReturn,
} from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function RecordReturnRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <RecordReturnScreen company={company} />}
    </RequireAdmin>
  );
}

/** Cash the holder handed back outside the app (spec §6.22); nothing is paid. */
function RecordReturnScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { floatId } = useLocalSearchParams<{ floatId: string }>();
  const float = useFloat(company.organizationId, floatId);
  const record = useRecordFloatReturn(company.organizationId, floatId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function submit(): void {
    const request = { amountKes: amount, note };
    const parsed = recordFloatReturnRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the amount.");
      return;
    }
    setFormError(null);
    record.mutate(request, { onSuccess: () => router.back() });
  }

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        {float.data
          ? `${kes(float.data.leftKes)} is on this float. Record what they handed back in cash.`
          : "Record what they handed back in cash."}
      </Text>
      <TextField
        label="Amount handed back (KES)"
        value={amount}
        onChangeText={setAmount}
        placeholder="1,250"
        keyboardType="decimal-pad"
      />
      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        placeholder="Cash counted with the office manager"
        multiline
        maxLength={FLOAT_NOTE_MAX_LENGTH}
      />
      <View className="gap-3">
        <ErrorMessage
          message={
            formError ??
            (record.isError ? describeApiError(record.error) : null)
          }
        />
        <Button
          label="Record the return"
          loading={record.isPending}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}
