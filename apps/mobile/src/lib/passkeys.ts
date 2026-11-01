/**
 * WebAuthn relying party for Privy login passkeys. The API's approval
 * passkeys use the same RP ID (`WEBAUTHN_RP_ID`), and `app.config.ts`
 * associates the app with this domain.
 */
export const PASSKEY_RELYING_PARTY = "https://business.expendi.app";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function isPasskeyCancellation(error: unknown): boolean {
  return /cancel/i.test(messageOf(error));
}

export function isPasskeyAlreadyOnDevice(error: unknown): boolean {
  return /excluded credential|already exists on the local device/i.test(
    messageOf(error),
  );
}
