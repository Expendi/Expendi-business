"use client";

import { usePrivy } from "@privy-io/react-auth";
import { createContext, useContext, useMemo } from "react";

import type { ApiClient } from "./api";
import { readPublicEnv } from "~/env";
import { createApiClient } from "./api";

const ApiClientOverrideContext = createContext<ApiClient | null>(null);

/** Replaces the API for everything inside it; the dev preview's sample data uses it. */
export const ApiClientOverride = ApiClientOverrideContext.Provider;

/** The same authenticated, schema-checked client used by sign-in. */
export function useApi() {
  const override = useContext(ApiClientOverrideContext);
  const { getAccessToken } = usePrivy();
  return useMemo(() => {
    if (override) return override;
    const env = readPublicEnv();
    if (!env.ok) throw new Error("Dashboard API configuration is missing");
    return createApiClient({
      baseUrl: env.env.NEXT_PUBLIC_API_URL,
      getAccessToken,
    });
  }, [override, getAccessToken]);
}
