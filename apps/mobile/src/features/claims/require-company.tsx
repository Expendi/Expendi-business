import type { JSX } from "react";
import { Redirect } from "expo-router";

import type { Company } from "~/features/company/company-provider";
import { LoadingScreen } from "~/components/loading-screen";
import { AccountErrorScreen } from "~/features/company/account-error-screen";
import { useCompanySession } from "~/features/company/company-provider";

/** Screens for any active member of the selected company (spec §4). */
export function RequireCompany({
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
  if (state.status !== "ready") return <Redirect href="/" />;
  return children(state.company);
}
