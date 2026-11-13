import type { JSX } from "react";
import { Redirect, Stack } from "expo-router";

import type { CompanyState } from "~/features/company/company-provider";
import { LoadingScreen } from "~/components/loading-screen";
import { AccountErrorScreen } from "~/features/company/account-error-screen";
import { useCompanySession } from "~/features/company/company-provider";
import { FullNameStep } from "~/features/me/full-name-step";

/** Cash-outs are paid in the person's name, so it comes before anything else (spec §6.2). */
function needsFullName(state: CompanyState): boolean {
  return "me" in state && state.me.user.fullName === null;
}

export default function AppLayout(): JSX.Element {
  const { state, retry } = useCompanySession();

  if (needsFullName(state)) return <FullNameStep />;

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
