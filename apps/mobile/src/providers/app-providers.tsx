import type { JSX, ReactNode } from "react";

import type { PublicEnv } from "~/lib/env";
import { AuthProvider } from "~/features/auth/auth-provider";
import { CompanyProvider } from "~/features/company/company-provider";
import { ApiProvider } from "./api-provider";
import { QueryProvider } from "./query-provider";

export function AppProviders({
  env,
  children,
}: {
  env: PublicEnv;
  children: ReactNode;
}): JSX.Element {
  return (
    <QueryProvider>
      <AuthProvider
        privyAppId={env.EXPO_PUBLIC_PRIVY_APP_ID}
        privyClientId={env.EXPO_PUBLIC_PRIVY_CLIENT_ID}
      >
        <ApiProvider baseUrl={env.EXPO_PUBLIC_API_URL}>
          <CompanyProvider>{children}</CompanyProvider>
        </ApiProvider>
      </AuthProvider>
    </QueryProvider>
  );
}
