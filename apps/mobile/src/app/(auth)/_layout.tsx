import type { JSX } from "react";
import { Stack } from "expo-router";

import { useAuth } from "~/features/auth/auth-provider";

export default function AuthLayout(): JSX.Element {
  const { status } = useAuth();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status !== "offering-passkey"}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="verify" />
      </Stack.Protected>
      <Stack.Protected guard={status === "offering-passkey"}>
        <Stack.Screen
          name="set-up-passkey"
          options={{ gestureEnabled: false }}
        />
      </Stack.Protected>
    </Stack>
  );
}
