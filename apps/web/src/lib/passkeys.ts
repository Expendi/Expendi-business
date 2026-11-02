/**
 * Privy's browser passkeys belong to the site's own domain, so on
 * `business.expendi.app` they are the same passkeys the app uses (its
 * relying party), including one kept on a phone and used through the
 * browser's "use a phone or tablet" option.
 */
export function browserSupportsPasskeys(): boolean {
  return "PublicKeyCredential" in window;
}

/** Closing the browser's passkey sheet, or letting it time out. */
export function isPasskeyCancellation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return true;
  }
  return error instanceof Error && /cancel|not allowed/i.test(error.message);
}
