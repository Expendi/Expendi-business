"use client";

import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { BrandMark } from "~/components/brand-mark";
import { FullScreenMessage } from "~/components/full-screen-message";
import { PasskeyOffer } from "~/components/passkey-offer";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex items-center gap-3 text-lg font-semibold tracking-tight">
        <BrandMark />
        Expendi Business
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>Sign in to your workspace</h1>
          </CardTitle>
          <CardDescription>
            For company admins and accountants. Sign in with your work email;
            we&apos;ll send you a code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {message ? (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="button"
            onClick={signInWithEmail}
            disabled={passkeySignInPending}
            className="w-full"
          >
            Sign in with email
          </Button>

          {browserSupportsPasskeys() ? (
            <>
              <div className="mt-6 flex items-center gap-3">
                <Separator className="flex-1" />
                <p className="shrink-0 text-xs text-muted-foreground">
                  Set up a passkey before?
                </p>
                <Separator className="flex-1" />
              </div>
              <Button
                type="button"
                onClick={() => void onPasskey()}
                disabled={passkeySignInPending}
                className="mt-4 w-full"
                variant="outline"
              >
                {passkeySignInPending
                  ? "Waiting for your passkey…"
                  : "Sign in with a passkey"}
              </Button>
              <p className="mt-2 text-xs text-stone-500">
                A passkey on your phone works too: choose &ldquo;use a phone or
                tablet&rdquo; when your browser asks.
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
