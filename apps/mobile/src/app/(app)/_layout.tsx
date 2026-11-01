import type { JSX } from "react";
import { Redirect, Stack } from "expo-router";

import { LoadingScreen } from "~/components/loading-screen";
import { AccountErrorScreen } from "~/features/company/account-error-screen";
import { useCompanySession } from "~/features/company/company-provider";

export default function AppLayout(): JSX.Element {
  const { state, retry } = useCompanySession();

  switch (state.status) {
    case "loading":
      return <LoadingScreen label="Loading your account" />;
    case "error":
      return <AccountErrorScreen error={state.error} onRetry={retry} />;
    case "no-company":
      return <Redirect href="/create-company" />;
    case "choose":
      return <Redirect href="/select-company" />;
    case "ready":
      return <Stack screenOptions={{ headerShown: false }} />;
  }
}
