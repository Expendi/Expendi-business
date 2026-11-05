import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";

import {
  FULL_NAME_MAX_LENGTH,
  updateMeRequestSchema,
} from "@expendi-business/shared";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { useAuth } from "~/features/auth/auth-provider";
import { describeApiError } from "~/lib/api";
import { useUpdateFullName } from "./use-update-full-name";

/**
 * Asked once, at first sign-in, of anyone without a name (spec §6.2): a
 * company's creator, or someone invited without one. Claims are paid to
 * M-Pesa in this name, so it has to match the M-Pesa account.
 */
export function FullNameStep(): JSX.Element {
  const updateFullName = useUpdateFullName();
  const { signOut } = useAuth();
  const [fullName, setFullName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  function handleSubmit(): void {
    const parsed = updateMeRequestSchema.safeParse({ fullName });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter your full name.");
      return;
    }
    setFieldError(null);
    updateFullName.mutate(parsed.data);
  }

  return (
    <Screen>
      <View className="gap-2 pt-8">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          What’s your name?
        </Text>
        <Text className="text-base text-gray-600">
          Claims are paid to your M-Pesa in this name, so write it the way your
          M-Pesa account shows it.
        </Text>
      </View>

      <View className="gap-4">
        <TextField
          label="Your full name (as on your M-Pesa)"
          value={fullName}
          onChangeText={setFullName}
          placeholder="Jane Wanjiku"
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          autoCorrect={false}
          maxLength={FULL_NAME_MAX_LENGTH}
          editable={!updateFullName.isPending}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        <ErrorMessage
          message={
            fieldError ??
            (updateFullName.isError
              ? describeApiError(updateFullName.error)
              : null)
          }
        />
        <Button
          label="Continue"
          loading={updateFullName.isPending}
          onPress={handleSubmit}
        />
      </View>

      <Button
        label="Sign out"
        variant="ghost"
        disabled={updateFullName.isPending}
        onPress={() => void signOut()}
      />
    </Screen>
  );
}
