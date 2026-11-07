"use client";

import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { DashboardRole } from "~/config/roles";
import { AppShell } from "~/components/app-shell";
import { StaticAuthProvider } from "~/contexts/auth-context";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { ApiClientOverride } from "~/lib/use-api";
import { COMPANY_NAME, ORGANIZATION_ID, VIEWER } from "./fixtures/company";
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
  children,
}: {
  role: DashboardRole;
  currentPath: string;
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
            <AppShell
              name={VIEWER.name}
              email={VIEWER.email}
              onSwitchCompany={() => undefined}
              onSignOut={() => undefined}
              currentPath={currentPath}
            >
              {children}
            </AppShell>
          </DashboardProvider>
        </StaticAuthProvider>
      </ApiClientOverride>
    </QueryClientProvider>
  );
}
