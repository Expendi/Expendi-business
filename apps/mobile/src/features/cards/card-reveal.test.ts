import { describe, expect, it } from "vitest";

import {
  httpsOrigin,
  mayNavigateReveal,
  REVEAL_MAX_MS,
  revealLifetimeMs,
  revealMustClose,
} from "./card-reveal";

const ORIGIN = "https://business.expendi.app";
const PAGE = `${ORIGIN}/card-reveal#session=not-a-real-session`;

describe("httpsOrigin", () => {
  it.each([
    [PAGE, ORIGIN],
    ["https://BUSINESS.expendi.app/x", ORIGIN],
    ["https://business.expendi.app", ORIGIN],
    ["https://business.expendi.app?a=1", ORIGIN],
    ["https://business.expendi.app:8443/x", `${ORIGIN}:8443`],
  ])("reads %s", (url, origin) => {
    // #when
    const result = httpsOrigin(url);

    // #then
    expect(result).toBe(origin);
  });

  it.each([
    ["plain http", "http://business.expendi.app/x"],
    ["credentials", `https://business.expendi.app@elsewhere.example/`],
    ["a backslash", "https://business.expendi.app\\@elsewhere.example/"],
    ["a phone link", "tel:+254700000000"],
    ["an intent", "intent://x#Intent;end"],
    ["javascript", "javascript:alert(1)"],
    ["nothing", ""],
  ])("refuses %s", (_label, url) => {
    // #when
    const result = httpsOrigin(url);

    // #then
    expect(result).toBeNull();
  });
});

describe("mayNavigateReveal", () => {
  it("lets the reveal page load and move within its origin", () => {
    // #given
    const top = { isTopFrame: true };

    // #then
    expect(mayNavigateReveal(ORIGIN, { ...top, url: PAGE })).toBe(true);
    expect(mayNavigateReveal(ORIGIN, { ...top, url: `${ORIGIN}/other` })).toBe(
      true,
    );
  });

  it.each([
    ["another site", "https://elsewhere.example/"],
    ["a lookalike host", "https://business.expendi.app.elsewhere.example/"],
    ["a credentials trick", `https://business.expendi.app@elsewhere.example/`],
    ["plain http", "http://business.expendi.app/card-reveal"],
    ["a phone link", "tel:+254700000000"],
    ["a blank page", "about:blank"],
  ])("blocks the page leaving for %s", (_label, url) => {
    // #when
    const allowed = mayNavigateReveal(ORIGIN, { url, isTopFrame: true });

    // #then
    expect(allowed).toBe(false);
  });

  it("lets Lithic's embed load in an inner frame", () => {
    // #when
    const allowed = mayNavigateReveal(ORIGIN, {
      url: "https://sandbox.lithic.com/v1/embed/card",
      isTopFrame: false,
    });

    // #then
    expect(allowed).toBe(true);
  });

  it.each(["tel:+254700000000", "http://elsewhere.example/", "intent://x"])(
    "keeps %s out of inner frames",
    (url) => {
      // #when
      const allowed = mayNavigateReveal(ORIGIN, { url, isTopFrame: false });

      // #then
      expect(allowed).toBe(false);
    },
  );
});

describe("revealLifetimeMs", () => {
  const NOW = Date.parse("2026-11-08T10:00:00.000Z");

  it("lasts until the session expires", () => {
    // #when
    const lifetime = revealLifetimeMs("2026-11-08T10:02:00.000Z", NOW);

    // #then
    expect(lifetime).toBe(120_000);
  });

  it.each([
    ["already expired by this phone's clock", "2026-11-08T09:00:00.000Z"],
    ["far in the future by this phone's clock", "2026-11-08T12:00:00.000Z"],
    ["unreadable", "not a date"],
  ])("caps a session that's %s", (_label, expiresAt) => {
    // #when
    const lifetime = revealLifetimeMs(expiresAt, NOW);

    // #then
    expect(lifetime).toBe(REVEAL_MAX_MS);
  });
});

describe("revealMustClose", () => {
  it.each(["background", "inactive"])("closes when the app is %s", (state) => {
    expect(revealMustClose(state)).toBe(true);
  });

  it("stays open while the app is in front", () => {
    expect(revealMustClose("active")).toBe(false);
  });
});
