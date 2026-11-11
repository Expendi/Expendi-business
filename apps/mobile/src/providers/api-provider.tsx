import type { JSX, ReactNode } from "react";
import { usePrivy } from "@privy-io/expo";
import { createContext, useContext, useMemo } from "react";

import type { ApiClient } from "~/lib/api";
import { createApiClient } from "~/lib/api";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: ReactNode;
}): JSX.Element {
  const { getAccessToken } = usePrivy();
  const api = useMemo(
    () => createApiClient({ baseUrl, getAccessToken }),
    [baseUrl, getAccessToken],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** Supplies a ready-made client, e.g. the read-only fixtures in dev previews. */
export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): JSX.Element {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside ApiProvider");
  return api;
}
