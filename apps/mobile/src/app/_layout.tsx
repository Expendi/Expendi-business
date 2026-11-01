import "../../global.css";

import type { JSX } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Text, View } from "react-native";

import { useAuth } from "~/features/auth/auth-provider";
import { readPublicEnv } from "~/lib/env";
import { AppProviders } from "~/providers/app-providers";

void SplashScreen.preventAutoHideAsync();

const publicEnv = readPublicEnv();

export default function RootLayout(): JSX.Element {
  if (!publicEnv.ok) return <MissingConfig keys={publicEnv.invalidKeys} />;

  return (
    <AppProviders env={publicEnv.env}>
      <RootNavigator />
      <StatusBar style="dark" />
    </AppProviders>
  );
}

function withHeader(title: string) {
  return {
    headerShown: true,
    title,
    headerBackButtonDisplayMode: "minimal",
    headerShadowVisible: false,
  } as const;
}

function RootNavigator(): JSX.Element {
  const { status } = useAuth();
  const isSignedIn = status === "signed-in";

  useEffect(() => {
    if (status !== "loading") void SplashScreen.hideAsync();
  }, [status]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isSignedIn}>
        <Stack.Screen name="(app)" />
        <Stack.Screen
          name="(onboarding)/create-company"
          options={withHeader("Create a company")}
        />
        <Stack.Screen
          name="select-company"
          options={withHeader("Choose a company")}
        />
        <Stack.Screen name="(admin)/wallet" options={withHeader("Wallet")} />
        <Stack.Screen name="(admin)/team/index" options={withHeader("Team")} />
        <Stack.Screen
          name="(admin)/team/invite"
          options={withHeader("Invite someone")}
        />
        <Stack.Screen
          name="(admin)/team/[membershipId]"
          options={withHeader("Team member")}
        />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

function MissingConfig({ keys }: { keys: string[] }): JSX.Element {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <View className="flex-1 justify-center gap-3 bg-white px-6">
      <Text className="text-lg font-semibold text-gray-900">
        App configuration is missing
      </Text>
      <Text className="text-base text-gray-600">
        Set these in apps/mobile/.env, then restart Metro:
      </Text>
      {keys.map((key) => (
        <Text key={key} className="font-mono text-sm text-gray-900">
          {key}
        </Text>
      ))}
    </View>
  );
}
