import { useCallback, useEffect, useRef } from "react";

/** A callback whose identity never changes, so columns built on it can be memoized. */
export function useStableOpen(
  onOpen: (id: string) => void,
): (id: string) => void {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  return useCallback((id: string) => latest.current(id), []);
}
