"use client";

import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { TreasuryScenario } from "./fixtures/treasury";
import type { DashboardRole } from "~/config/roles";
import { TreasuryOfferProvider } from "~/app/(company)/wallet/_components/treasury-offer";
import { AppShell } from "~/components/app-shell";
import { StaticAuthProvider } from "~/contexts/auth-context";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { ApiClientOverride } from "~/lib/use-api";
import { COMPANY_NAME, ORGANIZATION_ID, VIEWER } from "./fixtures/company";
import { seedTreasury } from "./fixtures/treasury";
import { createPreviewApi } from "./preview-api";
import { seedSampleData } from "./seed";

/**
 * What `(company)/layout.tsx` gives a page, with sample data in place of
 * Privy and the API: a seeded query client, a signed-in session, the
 * company and the real shell.
 */
export function PreviewProviders({
  role,
  currentPath,
  treasury,
  children,
}: {
  role: DashboardRole;
  currentPath: string;
  treasury?: TreasuryScenario;
  children: ReactNode;
}): JSX.Element {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          retry: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    seedSampleData(client);
    if (treasury) seedTreasury(client, treasury);
    return client;
  });
  const [api] = useState(createPreviewApi);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientOverride value={api}>
        <StaticAuthProvider api={api}>
          <DashboardProvider
            company={{
              organizationId: ORGANIZATION_ID,
              name: COMPANY_NAME,
              role,
            }}
          >
            <TreasuryOfferProvider>
              <AppShell
                name={VIEWER.name}
                email={VIEWER.email}
                onSwitchCompany={() => undefined}
                onSignOut={() => undefined}
                currentPath={currentPath}
              >
                {children}
              </AppShell>
            </TreasuryOfferProvider>
          </DashboardProvider>
        </StaticAuthProvider>
      </ApiClientOverride>
    </QueryClientProvider>
  );
}
