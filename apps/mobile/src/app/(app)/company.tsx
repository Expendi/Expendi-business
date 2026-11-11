import type { JSX } from "react";

import { LoadingScreen } from "~/components/loading-screen";
import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import { CompanyScreen } from "~/features/company/company-screen";
import { RequireAdmin } from "~/features/company/require-admin";

export default function CompanyRoute(): JSX.Element {
  const { signOut } = useAuth();
  const { state } = useCompanySession();
  return (
    <RequireAdmin>
      {(company) =>
        state.status === "ready" ? (
          <CompanyScreen
            key={company.organizationId}
            me={state.me}
            company={company}
            canSwitch={state.companies.length > 1}
            onSignOut={signOut}
          />
        ) : (
          <LoadingScreen label="Loading your company" />
        )
      }
    </RequireAdmin>
  );
}
