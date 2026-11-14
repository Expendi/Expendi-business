import "../../global.css";

import type { JSX } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";

import { Text } from "~/components/text";
import { useAuth } from "~/features/auth/auth-provider";
import { PushNotifications } from "~/features/notifications/push-notifications";
import { readPublicEnv } from "~/lib/env";
import { AppProviders } from "~/providers/app-providers";
import { colors } from "~/theme/colors";

void SplashScreen.preventAutoHideAsync();

const publicEnv = readPublicEnv();

export default function RootLayout(): JSX.Element {
  if (!publicEnv.ok) return <MissingConfig keys={publicEnv.invalidKeys} />;

  return (
    <AppProviders env={publicEnv.env}>
      <RootNavigator />
      <PushNotifications />
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
    headerTintColor: colors.text,
    headerStyle: { backgroundColor: colors.background },
    contentStyle: { backgroundColor: colors.background },
    headerTitleStyle: { fontFamily: "Outfit", fontWeight: "600" },
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
          name="(admin)/export"
          options={withHeader("Monthly export")}
        />
        <Stack.Screen
          name="(onboarding)/create-company"
          options={withHeader("Create a company")}
        />
        <Stack.Screen
          name="select-company"
          options={withHeader("Choose a company")}
        />
        <Stack.Screen
          name="(admin)/wallet/index"
          options={withHeader("Wallet")}
        />
        <Stack.Screen
          name="(admin)/wallet/history"
          options={withHeader("Wallet history")}
        />
        <Stack.Screen
          name="(admin)/wallet/fund-in"
          options={withHeader("Fund in")}
        />
        <Stack.Screen
          name="(admin)/wallet/withdraw"
          options={withHeader("Withdraw")}
        />
        <Stack.Screen
          name="(admin)/wallet/addresses"
          options={withHeader("Withdrawal addresses")}
        />
        <Stack.Screen name="(admin)/team/index" options={withHeader("Team")} />
        <Stack.Screen
          name="(admin)/team/invite"
          options={withHeader("Invite someone")}
        />
        <Stack.Screen
          name="(admin)/team/[membershipId]"
          options={withHeader("Team member")}
        />
        <Stack.Screen
          name="(admin)/payees/index"
          options={withHeader("Payees")}
        />
        <Stack.Screen
          name="(admin)/payees/new"
          options={withHeader("New payee")}
        />
        <Stack.Screen
          name="(admin)/payees/[payeeId]/index"
          options={withHeader("Payee")}
        />
        <Stack.Screen
          name="(admin)/payees/[payeeId]/details"
          options={withHeader("Payment details")}
        />
        <Stack.Screen
          name="(admin)/bills/new"
          options={withHeader("New bill")}
        />
        <Stack.Screen
          name="(admin)/bills/[billId]/index"
          options={withHeader("Bill")}
        />
        <Stack.Screen
          name="(admin)/bills/[billId]/edit"
          options={withHeader("Edit bill")}
        />
        <Stack.Screen
          name="(admin)/bills/[billId]/mark-paid"
          options={withHeader("Mark paid")}
        />
        <Stack.Screen
          name="(admin)/recurring/index"
          options={withHeader("Recurring payments")}
        />
        <Stack.Screen
          name="(admin)/recurring/new"
          options={withHeader("New recurring payment")}
        />
        <Stack.Screen
          name="(admin)/recurring/[itemId]/index"
          options={withHeader("Recurring payment")}
        />
        <Stack.Screen
          name="(admin)/recurring/[itemId]/edit"
          options={withHeader("Edit recurring payment")}
        />
        <Stack.Screen
          name="(admin)/spending/index"
          options={withHeader("Company spending")}
        />
        <Stack.Screen
          name="(admin)/spending/new"
          options={withHeader("Record spending")}
        />
        <Stack.Screen
          name="(admin)/spending/accounts"
          options={withHeader("Paid-from accounts")}
        />
        <Stack.Screen
          name="(admin)/spending/[spendingId]/index"
          options={withHeader("Company spending")}
        />
        <Stack.Screen
          name="(admin)/spending/[spendingId]/edit"
          options={withHeader("Edit spending")}
        />
        <Stack.Screen
          name="(admin)/approvals/index"
          options={withHeader("Reimbursements")}
        />
        <Stack.Screen
          name="(admin)/approvals/[claimId]/pay"
          options={withHeader("Approve and pay")}
        />
        <Stack.Screen
          name="(admin)/payroll/salaries/index"
          options={withHeader("Salaries")}
        />
        <Stack.Screen
          name="(admin)/payroll/salaries/new"
          options={withHeader("New salary")}
        />
        <Stack.Screen
          name="(admin)/payroll/salaries/[salaryId]"
          options={withHeader("Salary")}
        />
        <Stack.Screen
          name="(admin)/payroll/runs/[runId]"
          options={withHeader("Payroll run")}
        />
        <Stack.Screen
          name="(employee)/salary-payments"
          options={withHeader("My salary payments")}
        />
        <Stack.Screen
          name="(employee)/claims/index"
          options={withHeader("Reimbursements")}
        />
        <Stack.Screen
          name="(employee)/claims/new"
          options={withHeader("New reimbursement")}
        />
        <Stack.Screen
          name="(employee)/claims/[claimId]/index"
          options={withHeader("Reimbursement")}
        />
        <Stack.Screen
          name="(employee)/claims/[claimId]/edit"
          options={withHeader("Edit reimbursement")}
        />
        <Stack.Screen
          name="(employee)/cards/index"
          options={withHeader("My Expendi cards")}
        />
        <Stack.Screen
          name="(employee)/cards/[cardId]/index"
          options={withHeader("Card")}
        />
        <Stack.Screen
          name="(employee)/cards/[cardId]/reveal"
          options={withHeader("Card details")}
        />
        <Stack.Screen
          name="(employee)/cards/purchases/[purchaseId]/index"
          options={withHeader("Purchase")}
        />
        <Stack.Screen
          name="(employee)/cards/purchases/[purchaseId]/receipt"
          options={withHeader("Add receipt")}
        />
        <Stack.Screen
          name="(employee)/petty-cash/index"
          options={withHeader("Petty cash")}
        />
        <Stack.Screen
          name="(employee)/petty-cash/new"
          options={withHeader("Paid from petty cash")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/index"
          options={withHeader("Petty cash floats")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/new"
          options={withHeader("Issue a float")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/[floatId]/index"
          options={withHeader("Float")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/[floatId]/top-up"
          options={withHeader("Top up")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/[floatId]/pay"
          options={withHeader("Approve & pay")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/[floatId]/return"
          options={withHeader("Cash handed back")}
        />
        <Stack.Screen
          name="(admin)/petty-cash/floats/[floatId]/close"
          options={withHeader("Close the float")}
        />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      {__DEV__ ? <Stack.Screen name="preview" /> : null}
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
