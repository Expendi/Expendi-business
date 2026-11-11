"use client";

import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { StaffMeResponse } from "@expendi-business/shared";

import { AppShell } from "~/components/app-shell";
import { ROLE_LABELS } from "~/config/roles";
import { StaticStaffAuthProvider } from "~/contexts/staff-auth-context";
import { createInternalApi } from "~/lib/internal-api";
import { createPreviewApi } from "./preview-api";
import { seedSampleData } from "./seed";

/**
 * What `(staff)/layout.tsx` gives a page, with sample data in place of
 * Privy and the API: a seeded query client, a signed-in staff member and
 * the real shell.
 */
export function PreviewProviders({
  staff,
  currentPath,
  children,
}: {
  staff: StaffMeResponse;
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
  const [api] = useState(() => createInternalApi(createPreviewApi()));

  return (
    <QueryClientProvider client={queryClient}>
      <StaticStaffAuthProvider api={api} staff={staff}>
        <AppShell
          email={staff.email}
          role={ROLE_LABELS[staff.role]}
          onSignOut={() => undefined}
          currentPath={currentPath}
        >
          {children}
        </AppShell>
      </StaticStaffAuthProvider>
    </QueryClientProvider>
  );
}
