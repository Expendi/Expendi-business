import { create, get } from "react-native-passkeys";

import type {
  PasskeyCreationOptions,
  PasskeyRequestOptions,
} from "@expendi-business/shared";

import { isPasskeyCancellation } from "~/lib/passkeys";

/**
 * The phone's side of an approval passkey (spec §7.3). The API's
 * `@simplewebauthn/server` options go to `react-native-passkeys` as they
 * are, and its JSON goes back to the API to verify. A person backing out of
 * the fingerprint or face prompt is `null`, not an error.
 */

export type PasskeyRegistration = NonNullable<
  Awaited<ReturnType<typeof create>>
>;
export type PasskeyAssertion = NonNullable<Awaited<ReturnType<typeof get>>>;

/** The passkey prompt failed for a reason other than the person cancelling. */
export class PasskeyUnavailableError extends Error {
  override readonly name = "PasskeyUnavailableError";
}

const CREATE_FAILED =
  "We couldn't set up a passkey on this phone. Check it has a screen lock, then try again.";
const SIGN_FAILED =
  "Your passkey couldn't be used on this phone. If you set it up on another phone, use that one.";

async function unlessCancelled<T>(
  ceremony: () => Promise<T | null>,
  failure: string,
): Promise<T | null> {
  let result: T | null;
  try {
    result = await ceremony();
  } catch (error) {
    if (isPasskeyCancellation(error)) return null;
    throw new PasskeyUnavailableError(failure, { cause: error });
  }
  if (result === null) throw new PasskeyUnavailableError(failure);
  return result;
}

/** Creates the approval passkey on this phone; null if the person cancels. */
export function createApprovalPasskey(
  options: PasskeyCreationOptions,
): Promise<PasskeyRegistration | null> {
  return unlessCancelled(
    () =>
      create({
        rp: options.rp,
        user: options.user,
        challenge: options.challenge,
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        // The type requires the key because the DOM's optional AbortSignal
        // isn't in React Native's libs; the native module never reads it.
        signal: undefined,
      }),
    CREATE_FAILED,
  );
}

/** Signs one approval challenge; null if the person cancels. */
export function signApprovalChallenge(
  options: PasskeyRequestOptions,
): Promise<PasskeyAssertion | null> {
  return unlessCancelled(
    () =>
      get({
        challenge: options.challenge,
        rpId: options.rpId,
        allowCredentials: options.allowCredentials,
        userVerification: options.userVerification,
        timeout: options.timeout,
      }),
    SIGN_FAILED,
  );
}
