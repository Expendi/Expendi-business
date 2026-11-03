"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { BrandMark } from "~/components/brand-mark";
import { FullScreenMessage } from "~/components/full-screen-message";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";

export default function SignInPage() {
  const router = useRouter();
  const { status, notice, signIn } = useStaffAuth();

  useEffect(() => {
    if (status === "signed-in" || status === "unavailable") {
      router.replace("/companies");
    }
  }, [status, router]);

  if (status !== "signed-out") {
    return <FullScreenMessage>Checking your staff account…</FullScreenMessage>;
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
            <h1>Sign in to Operations</h1>
          </CardTitle>
          <CardDescription>
            For the Expendi team. Sign in with your work email.
          </CardDescription>
        </CardHeader>

        {notice ? (
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          </CardContent>
        ) : null}

        <CardFooter>
          <Button type="button" onClick={signIn} className="w-full">
            Sign in with email
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
