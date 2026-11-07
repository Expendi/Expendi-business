"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * One query param as state, e.g. the open bill (`?billId=…`), so a detail
 * can be linked to and survives a reload. Writes with `router.replace`, so
 * opening and stepping through details doesn't fill the history. Keeps the
 * other params. The page must render inside a `<Suspense>`, as any
 * `useSearchParams` reader must.
 */
export function useDeepLinkParam(
  name: string,
): readonly [string | null, (value: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(name);

  const setValue = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null || next === "") params.delete(name);
      else params.set(name, next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [name, pathname, router, searchParams],
  );

  return [value === "" ? null : value, setValue] as const;
}

/**
 * Several query params as state, e.g. a page's filters and its open item,
 * for changes that set or clear more than one at once: separate
 * `useDeepLinkParam` writes in one event would overwrite each other.
 */
export function useDeepLinkParams<N extends string>(): readonly [
  (name: N) => string | null,
  (changes: Partial<Readonly<Record<N, string | null>>>) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const read = useCallback(
    (name: N) => {
      const value = searchParams.get(name);
      return value === "" ? null : value;
    },
    [searchParams],
  );

  const write = useCallback(
    (changes: Partial<Readonly<Record<N, string | null>>>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [name, next] of Object.entries<string | null | undefined>(
        changes,
      )) {
        if (next === null || next === undefined || next === "") {
          params.delete(name);
        } else {
          params.set(name, next);
        }
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  return [read, write] as const;
}
