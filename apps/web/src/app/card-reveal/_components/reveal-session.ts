const SESSION_PREFIX = "#session=";

/** Undefined until the page has looked; null when there's no session. */
export type RevealSession = string | null | undefined;

/** The session carried in a URL fragment, `#session=…`. */
export function sessionFromHash(hash: string): string | null {
  if (!hash.startsWith(SESSION_PREFIX)) return null;
  try {
    const session = decodeURIComponent(hash.slice(SESSION_PREFIX.length));
    return session === "" ? null : session;
  } catch {
    return null;
  }
}

/** What the store needs of the page, so tests can stand in for it. */
export interface RevealPage {
  readonly location: Pick<Location, "hash" | "pathname" | "search">;
  readonly history: Pick<History, "replaceState">;
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

export interface RevealSessionStore {
  readonly subscribe: (notify: () => void) => () => void;
  readonly read: () => RevealSession;
}

/**
 * Reads the session out of the URL once the page is live and removes it
 * from the address bar at once, so it isn't left in history or a screenshot.
 * React re-subscribes in Strict Mode, by which time the fragment is gone, so
 * a session already taken is kept. A later `#session=…` replaces it.
 */
export function createRevealSessionStore(
  page: () => RevealPage,
): RevealSessionStore {
  let session: RevealSession;
  return {
    read: () => session,
    subscribe(notify) {
      const current = page();
      const take = () => {
        const { hash, pathname, search } = current.location;
        if (hash.startsWith(SESSION_PREFIX)) {
          current.history.replaceState(null, "", `${pathname}${search}`);
        }
        session = sessionFromHash(hash) ?? session ?? null;
        notify();
      };
      take();
      current.addEventListener("hashchange", take);
      return () => current.removeEventListener("hashchange", take);
    },
  };
}
