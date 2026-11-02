"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useMemo } from "react";

import { readPublicEnv } from "~/env";
import { createApiClient } from "./api";

/** The same authenticated, schema-checked client used by sign-in. */
export function useApi() {
  const { getAccessToken } = usePrivy();
  return useMemo(() => {
    const env = readPublicEnv();
    if (!env.ok) throw new Error("Dashboard API configuration is missing");
    return createApiClient({
      baseUrl: env.env.NEXT_PUBLIC_API_URL,
      getAccessToken,
    });
  }, [getAccessToken]);
}
