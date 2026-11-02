"use client";

import type { JSX } from "react";
import { useLinkWithPasskey } from "@privy-io/react-auth";
import { useState } from "react";

import { useAuth } from "~/contexts/auth-context";
import { browserSupportsPasskeys, isPasskeyCancellation } from "~/lib/passkeys";
import { CenteredCard } from "./centered-card";
import { alertClass, primaryButton, textButton } from "./styles";

/** After an email-code sign-in, for someone with no passkey yet. */
export function PasskeyOffer(): JSX.Element {
  const { finishPasskeyOffer } = useAuth();
  const { linkWithPasskey } = useLinkWithPasskey();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsPasskeys();

  async function setUp(): Promise<void> {
    setLinking(true);
    setError(null);
    try {
      await linkWithPasskey();
      finishPasskeyOffer();
    } catch (linkError) {
      if (!isPasskeyCancellation(linkError)) {
        setError("We couldn't set up a passkey. Try again, or skip for now.");
      }
      setLinking(false);
    }
  }

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold">Sign in faster next time</h1>
      <p className="mt-2 text-sm text-stone-600">
        {supported
          ? "Set up a passkey and sign in with your fingerprint, face or phone instead of an email code."
          : "This browser can't use passkeys. You'll keep signing in with an email code."}
      </p>
      {error ? (
        <p role="alert" className={alertClass}>
          {error}
        </p>
      ) : null}
      {supported ? (
        <button
          type="button"
          onClick={() => void setUp()}
          disabled={linking}
          className={`mt-6 w-full ${primaryButton}`}
        >
          {linking ? "Setting up…" : "Set up a passkey"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={finishPasskeyOffer}
        disabled={linking}
        className={`mt-4 w-full ${supported ? textButton : primaryButton}`}
      >
        {supported ? "Skip for now" : "Continue"}
      </button>
    </CenteredCard>
  );
}
