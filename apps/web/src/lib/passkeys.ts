import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";

import type { PasskeyRequestOptions } from "@expendi-business/shared";

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

/** The signed challenge, as the API's `@simplewebauthn/server` verifies it. */
export type PasskeyAssertion = AuthenticationResponseJSON;

/** The passkey prompt failed for a reason other than the person cancelling. */
export class PasskeyUnavailableError extends Error {
  override readonly name = "PasskeyUnavailableError";
}

const SIGN_FAILED =
  "Your approval passkey couldn't be used in this browser. Try again, or choose “use a phone or tablet” to use the one on your phone.";

/**
 * Signs one money action's challenge with the admin's approval passkey
 * (spec §7.3), the same one the app uses; null if the person cancels.
 */
export async function signApprovalChallenge(
  options: PasskeyRequestOptions,
): Promise<PasskeyAssertion | null> {
  try {
    return await startAuthentication({
      optionsJSON: {
        ...options,
        // A passkey made in the app is stored as `internal`; passing that on
        // would stop a desktop browser offering "use a phone or tablet".
        allowCredentials: options.allowCredentials?.map(({ id, type }) => ({
          id,
          type,
        })),
      },
    });
  } catch (error) {
    if (
      isPasskeyCancellation(error) ||
      (error instanceof Error && isPasskeyCancellation(error.cause))
    ) {
      return null;
    }
    throw new PasskeyUnavailableError(SIGN_FAILED, { cause: error });
  }
}
