/**
 * The rules that keep Lithic's card-details page contained (spec §6.25). The
 * URL carries the session, so nothing here keeps it or looks past its host.
 */

/** Lithic's embed session lasts this long (`EMBED_SESSION_SECONDS` in the API). */
export const REVEAL_MAX_MS = 5 * 60_000;

const HTTPS_ORIGIN = /^https:\/\/([a-z0-9.-]+(?::\d+)?)(?:[/?#]|$)/i;

/**
 * `https://host[:port]`, or null for anything else. Stricter than a URL
 * parser on purpose: a URL with credentials in it, like
 * `https://expendi.app@elsewhere.example`, must not pass for its first host.
 */
export function httpsOrigin(url: string): string | null {
  const host = HTTPS_ORIGIN.exec(url)?.[1];
  return host === undefined ? null : `https://${host.toLowerCase()}`;
}

/**
 * The page itself stays on its origin. Lithic's embed is an iframe on another
 * origin, so inner frames only have to be web pages; Android reports every
 * navigation as the top frame, which only makes it stricter there.
 */
export function mayNavigateReveal(
  revealOrigin: string,
  request: { readonly url: string; readonly isTopFrame: boolean },
): boolean {
  if (request.isTopFrame) return httpsOrigin(request.url) === revealOrigin;
  return httpsOrigin(request.url) !== null || request.url.startsWith("about:");
}

/**
 * How long to leave the details up. The cap also covers a phone with the
 * wrong clock, for which `expiresAt` looks long gone or far away.
 */
export function revealLifetimeMs(expiresAt: string, now: number): number {
  const left = Date.parse(expiresAt) - now;
  return left > 0 && left < REVEAL_MAX_MS ? left : REVEAL_MAX_MS;
}

/** Anything but in front: iOS is `inactive` in the app switcher, where it would show. */
export function revealMustClose(appState: string): boolean {
  return appState !== "active";
}
