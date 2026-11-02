"use client";

import type { JSX, ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MissingConfig } from "~/components/missing-config";
import { AuthProvider } from "~/contexts/auth-context";
import { CompanyProvider } from "~/contexts/company-context";
import { readPublicEnv } from "~/env";

const publicEnv = readPublicEnv();

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: ReactNode }): JSX.Element {
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
        loginMethods: ["email", "passkey"],
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
        appearance: { landingHeader: "Sign in to Expendi Business" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider apiUrl={env.NEXT_PUBLIC_API_URL}>
          <CompanyProvider>{children}</CompanyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
