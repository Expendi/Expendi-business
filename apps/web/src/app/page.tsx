"use client";

import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CenteredCard } from "~/components/centered-card";
import { FullScreenMessage } from "~/components/full-screen-message";
import { PasskeyOffer } from "~/components/passkey-offer";
import {
  alertClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { HOME_PATH } from "~/config/navigation";
import { useAuth } from "~/contexts/auth-context";
import { browserSupportsPasskeys, isPasskeyCancellation } from "~/lib/passkeys";

export default function SignInPage(): JSX.Element {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === "signed-in") router.replace(HOME_PATH);
  }, [status, router]);

  if (status === "offering-passkey") return <PasskeyOffer />;
  if (status === "signed-out") return <SignInCard />;
  return <FullScreenMessage>Signing you in…</FullScreenMessage>;
}

function SignInCard(): JSX.Element {
  const { notice, signInWithEmail, signInWithPasskey, passkeySignInPending } =
    useAuth();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const message = passkeyError ?? notice;

  async function onPasskey(): Promise<void> {
    setPasskeyError(null);
    try {
      await signInWithPasskey();
    } catch (error) {
      if (isPasskeyCancellation(error)) return;
      setPasskeyError(
        "That passkey didn't work. Sign in with an email code, then set up a passkey again.",
      );
    }
  }

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold">Expendi Business</h1>
      <p className="mt-2 text-sm text-stone-600">
        For company admins and accountants. Sign in with your work email;
        we&apos;ll send you a code.
      </p>

      {message ? (
        <p role="alert" className={alertClass}>
          {message}
        </p>
      ) : null}

      <button
        type="button"
        onClick={signInWithEmail}
        disabled={passkeySignInPending}
        className={`mt-6 w-full ${primaryButton}`}
      >
        Sign in with email
      </button>

      {browserSupportsPasskeys() ? (
        <>
          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-stone-200" />
            <p className="text-xs text-stone-500">Set up a passkey before?</p>
            <div className="h-px flex-1 bg-stone-200" />
          </div>
          <button
            type="button"
            onClick={() => void onPasskey()}
            disabled={passkeySignInPending}
            className={`mt-4 w-full ${secondaryButton}`}
          >
            {passkeySignInPending
              ? "Waiting for your passkey…"
              : "Sign in with a passkey"}
          </button>
          <p className="mt-2 text-xs text-stone-500">
            A passkey on your phone works too: choose &ldquo;use a phone or
            tablet&rdquo; when your browser asks.
          </p>
        </>
      ) : null}
    </CenteredCard>
  );
}
