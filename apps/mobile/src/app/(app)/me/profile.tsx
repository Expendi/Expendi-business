import type { JSX } from "react";

import { LoadingScreen } from "~/components/loading-screen";
import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import { ProfileScreen } from "~/features/company/profile-screen";

export default function ProfileRoute(): JSX.Element {
  const { signOut } = useAuth();
  const { state } = useCompanySession();
  if (state.status !== "ready") {
    return <LoadingScreen label="Loading your account" />;
  }
  return (
    <ProfileScreen
      key={state.company.organizationId}
      me={state.me}
      company={state.company}
      canSwitch={state.companies.length > 1}
      onSignOut={signOut}
    />
  );
}
