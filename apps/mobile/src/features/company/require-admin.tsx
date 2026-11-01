import type { JSX } from "react";
import { Redirect } from "expo-router";

import type { Company } from "./company-provider";
import { LoadingScreen } from "~/components/loading-screen";
import { AccountErrorScreen } from "./account-error-screen";
import { useCompanySession } from "./company-provider";

/** Admin-only screens (spec §4); everyone else is sent home. */
export function RequireAdmin({
  children,
}: {
  children: (company: Company) => JSX.Element;
}): JSX.Element {
  const { state, retry } = useCompanySession();

  if (state.status === "loading") {
    return <LoadingScreen label="Loading your company" />;
  }
  if (state.status === "error") {
    return <AccountErrorScreen error={state.error} onRetry={retry} />;
  }
  if (state.status !== "ready" || state.company.role !== "admin") {
    return <Redirect href="/" />;
  }
  return children(state.company);
}
