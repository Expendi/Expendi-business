import { describe, expect, it, vi } from "vitest";

import type { RevealPage } from "./reveal-session";
import { createRevealSessionStore, sessionFromHash } from "./reveal-session";

function fakePage(hash: string, search = "") {
  const listeners = new Set<() => void>();
  const location = { hash, pathname: "/card-reveal", search };
  const replaceState = vi.fn((_data: unknown, _unused: string, url: string) => {
    location.hash = new URL(url, "https://business.test").hash;
  });
  const page: RevealPage = {
    location,
    history: { replaceState },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    page,
    location,
    replaceState,
    fireHashChange: () => {
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe("sessionFromHash", () => {
  it("reads the session, undoing the URL encoding", () => {
    expect({
      plain: sessionFromHash("#session=abc123"),
      encoded: sessionFromHash("#session=a%2Bb%3D%3D"),
    }).toEqual({ plain: "abc123", encoded: "a+b==" });
  });

  it("treats a missing or malformed fragment as no session", () => {
    expect({
      none: sessionFromHash(""),
      other: sessionFromHash("#tab=loads"),
      empty: sessionFromHash("#session="),
      malformed: sessionFromHash("#session=%E0%A4%A"),
    }).toEqual({ none: null, other: null, empty: null, malformed: null });
  });
});

describe("the reveal session store", () => {
  it("has no answer before the page is live", () => {
    // #given
    const { page } = fakePage("#session=abc");
    const store = createRevealSessionStore(() => page);

    // #then
    expect(store.read()).toBeUndefined();
  });

  it("takes the session and clears it from the URL right away", () => {
    // #given
    const { page, location, replaceState } = fakePage(
      "#session=abc",
      "?from=app",
    );
    const store = createRevealSessionStore(() => page);
    const notify = vi.fn();

    // #when
    store.subscribe(notify);

    // #then
    expect({
      session: store.read(),
      notified: notify.mock.calls.length,
      hash: location.hash,
      url: replaceState.mock.calls[0]?.[2],
    }).toEqual({
      session: "abc",
      notified: 1,
      hash: "",
      url: "/card-reveal?from=app",
    });
  });

  it("keeps the session when React subscribes a second time", () => {
    // #given
    const { page } = fakePage("#session=abc");
    const store = createRevealSessionStore(() => page);

    // #when
    store.subscribe(vi.fn())();
    store.subscribe(vi.fn());

    // #then
    expect(store.read()).toBe("abc");
  });

  it("answers null when the page opens without a session", () => {
    // #given
    const { page, replaceState } = fakePage("");
    const store = createRevealSessionStore(() => page);

    // #when
    store.subscribe(vi.fn());

    // #then
    expect({
      session: store.read(),
      touched: replaceState.mock.calls.length,
    }).toEqual({ session: null, touched: 0 });
  });

  it("clears a malformed session from the URL too", () => {
    // #given
    const { page, location } = fakePage("#session=%E0%A4%A");
    const store = createRevealSessionStore(() => page);

    // #when
    store.subscribe(vi.fn());

    // #then
    expect({ session: store.read(), hash: location.hash }).toEqual({
      session: null,
      hash: "",
    });
  });

  it("swaps to a newer session opened in the same page", () => {
    // #given
    const { page, location, fireHashChange } = fakePage("#session=first");
    const store = createRevealSessionStore(() => page);
    const notify = vi.fn();
    store.subscribe(notify);

    // #when
    location.hash = "#session=second";
    fireHashChange();

    // #then
    expect({
      session: store.read(),
      hash: location.hash,
      notified: notify.mock.calls.length,
    }).toEqual({ session: "second", hash: "", notified: 2 });
  });

  it("stops listening once unsubscribed", () => {
    // #given
    const { page, listeners } = fakePage("#session=abc");
    const store = createRevealSessionStore(() => page);

    // #when
    const unsubscribe = store.subscribe(vi.fn());
    const whileSubscribed = listeners.size;
    unsubscribe();

    // #then
    expect({ whileSubscribed, after: listeners.size }).toEqual({
      whileSubscribed: 1,
      after: 0,
    });
  });
});
