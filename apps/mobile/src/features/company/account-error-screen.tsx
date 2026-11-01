import type { JSX } from "react";
import { useState } from "react";
import { Text, View } from "react-native";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { useAuth } from "~/features/auth/auth-provider";
import { describeApiError } from "~/lib/api";

export function AccountErrorScreen({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): JSX.Element {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Screen>
      <View className="gap-4 pt-8">
        <Text className="text-2xl font-bold text-gray-900">
          We couldn’t load your account
        </Text>
        <ErrorMessage message={describeApiError(error)} />
      </View>
      <View className="gap-4">
        <Button label="Try again" onPress={onRetry} />
        <Button
          label="Sign out"
          variant="secondary"
          loading={signingOut}
          onPress={() => void handleSignOut()}
        />
      </View>
    </Screen>
  );
}
