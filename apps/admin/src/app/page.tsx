"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { FullScreenMessage } from "~/components/full-screen-message";
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
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8">
        <h1 className="text-lg font-semibold">Expendi Business Ops</h1>
        <p className="mt-2 text-sm text-stone-600">
          For the Expendi team. Sign in with your work email.
        </p>

        {notice ? (
          <p
            role="alert"
            className="mt-4 rounded-md bg-error-50 px-3 py-2 text-sm text-error-700"
          >
            {notice}
          </p>
        ) : null}

        <button
          type="button"
          onClick={signIn}
          className="mt-6 w-full rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        >
          Sign in with email
        </button>
      </div>
    </main>
  );
}
