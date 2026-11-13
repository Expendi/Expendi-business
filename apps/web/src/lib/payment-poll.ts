"use client";

import { useEffect, useRef } from "react";

/** Fewer payments on their way than at the last answer: one has settled. */
export function paymentsSettled(before: number, now: number): boolean {
  return now < before;
}

/**
 * Runs `refresh` when a payment a screen follows settles, so what's
 * derived from it (tab counts, an open detail, the balance) is asked again
 * now rather than once it goes stale. `inFlight` is how many are on their
 * way in the latest answer.
 */
export function useRefreshWhenSettled(
  inFlight: number,
  refresh: () => Promise<unknown>,
): void {
  const before = useRef(inFlight);
  useEffect(() => {
    const settled = paymentsSettled(before.current, inFlight);
    before.current = inFlight;
    if (settled) void refresh();
  }, [inFlight, refresh]);
}
