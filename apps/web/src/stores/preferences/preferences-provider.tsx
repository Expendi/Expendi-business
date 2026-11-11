"use client";

import type { JSX, ReactNode } from "react";
import type { StoreApi } from "zustand";
import { createContext, use, useEffect, useState } from "react";
import { useStore } from "zustand";

import type { PreferencesState } from "./preferences-store";
import type { PreferenceValueMap } from "~/lib/preferences/preferences-config";
import {
  applyThemeMode,
  resolveThemeMode,
  subscribeToSystemTheme,
} from "~/lib/preferences/theme-utils";
import { createPreferencesStore } from "./preferences-store";

const PreferencesStoreContext =
  createContext<StoreApi<PreferencesState> | null>(null);
const SidebarOpenContext = createContext(true);

/**
 * The layout preferences the root layout read from cookies, as a store the
 * shell and the layout controls share. It follows the system theme while
 * the mode is "System".
 */
export function PreferencesStoreProvider({
  initialValues,
  sidebarOpen,
  children,
}: {
  initialValues: PreferenceValueMap;
  /** The sidebar's saved open state, for `SidebarProvider`'s `defaultOpen`. */
  sidebarOpen: boolean;
  children: ReactNode;
}): JSX.Element {
  const [store] = useState(() => createPreferencesStore(initialValues));

  useEffect(() => {
    let stopFollowing: (() => void) | undefined;
    const follow = (mode: PreferenceValueMap["theme_mode"]) => {
      stopFollowing?.();
      stopFollowing = undefined;
      if (mode !== "system") return;
      store.setState({ resolvedThemeMode: resolveThemeMode("system") });
      stopFollowing = subscribeToSystemTheme(() => {
        store.setState({ resolvedThemeMode: applyThemeMode("system") });
      });
    };
    follow(store.getState().values.theme_mode);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.values.theme_mode !== previous.values.theme_mode) {
        follow(state.values.theme_mode);
      }
    });
    return () => {
      stopFollowing?.();
      unsubscribe();
    };
  }, [store]);

  return (
    <PreferencesStoreContext value={store}>
      <SidebarOpenContext value={sidebarOpen}>{children}</SidebarOpenContext>
    </PreferencesStoreContext>
  );
}

export function usePreferencesStore<T>(
  selector: (state: PreferencesState) => T,
): T {
  const store = use(PreferencesStoreContext);
  if (!store) throw new Error("Missing PreferencesStoreProvider");
  return useStore(store, selector);
}

export function useSidebarDefaultOpen(): boolean {
  return use(SidebarOpenContext);
}
