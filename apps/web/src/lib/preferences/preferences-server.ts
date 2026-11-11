import { cookies } from "next/headers";

import type { PreferenceValueMap } from "./preferences-config";
import { parsePreferences, SIDEBAR_STATE_COOKIE } from "./preferences-config";

/** The saved layout preferences and whether the sidebar was left open. */
export async function readPreferenceCookies(): Promise<{
  preferences: PreferenceValueMap;
  sidebarOpen: boolean;
}> {
  const store = await cookies();
  return {
    preferences: parsePreferences((key) => store.get(key)?.value),
    sidebarOpen: store.get(SIDEBAR_STATE_COOKIE)?.value !== "false",
  };
}
