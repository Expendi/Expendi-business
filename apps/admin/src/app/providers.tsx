"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MissingConfig } from "~/components/missing-config";
import { StaffAuthProvider } from "~/contexts/staff-auth-context";
import { readPublicEnv } from "~/env";

const publicEnv = readPublicEnv();

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  if (!publicEnv.ok) {
    return <MissingConfig invalidKeys={publicEnv.invalidKeys} />;
  }
  const { env } = publicEnv;

  return (
    <PrivyProvider
      appId={env.NEXT_PUBLIC_PRIVY_APP_ID}
      clientId={env.NEXT_PUBLIC_PRIVY_CLIENT_ID}
      config={{
        loginMethods: ["email"],
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
        appearance: { landingHeader: "Sign in to Expendi Business Ops" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <StaffAuthProvider apiUrl={env.NEXT_PUBLIC_API_URL}>
          {children}
        </StaffAuthProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
