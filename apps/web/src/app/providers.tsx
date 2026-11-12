"use client";

import type { JSX, ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";

import { MissingConfig } from "~/components/missing-config";
import { AuthProvider } from "~/contexts/auth-context";
import { CompanyProvider } from "~/contexts/company-context";
import { readPublicEnv } from "~/env";

const publicEnv = readPublicEnv();

/**
 * Pages that stand alone: a card's details are shown with no account and
 * no third-party script on the page but Lithic's embed.
 */
const STANDALONE_PATHS: ReadonlySet<string> = new Set(["/card-reveal"]);

/** Invoice pay links (`/pay/<public ID>`) are opened by customers with no account. */
const STANDALONE_PATH_PREFIXES: readonly string[] = ["/pay/"];

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
  const pathname = usePathname();
  const queryClient = getQueryClient();

  if (process.env.NODE_ENV === "development" && pathname.startsWith("/dev/")) {
    return <>{children}</>;
  }

  if (
    STANDALONE_PATHS.has(pathname) ||
    STANDALONE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return <>{children}</>;
  }

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
