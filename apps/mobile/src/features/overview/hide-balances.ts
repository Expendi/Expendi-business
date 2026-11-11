import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";

import { queryKeys } from "~/lib/query-keys";

const STORAGE_KEY = "hide-balances";

/** The eye on Home: whether balances are masked, remembered on this phone. */
export function useHideBalances(): {
  hidden: boolean;
  toggle: () => void;
} {
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: queryKeys.hideBalances,
    queryFn: async () =>
      (await SecureStore.getItemAsync(STORAGE_KEY)) === "true",
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: (hidden: boolean) =>
      SecureStore.setItemAsync(STORAGE_KEY, String(hidden)),
    onMutate: (hidden) => {
      queryClient.setQueryData(queryKeys.hideBalances, hidden);
    },
  });
  const hidden = stored.data ?? false;
  return { hidden, toggle: () => save.mutate(!hidden) };
}
