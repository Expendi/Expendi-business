import type { JSX, ReactNode } from "react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { createQueryClient } from "~/lib/query-client";

export function QueryProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [queryClient] = useState(createQueryClient);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      focusManager.setFocused(state === "active");
    });
    return () => subscription.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
