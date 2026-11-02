"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { FullScreenMessage } from "~/components/full-screen-message";
import { Sidebar } from "~/components/sidebar";
import { useStaffAuth } from "~/contexts/staff-auth-context";

export default function StaffLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { status, staff, error, retry, signOut } = useStaffAuth();

  useEffect(() => {
    if (status === "signed-out") router.replace("/");
  }, [status, router]);

  if (status === "unavailable") {
    return (
      <FullScreenMessage>
        <p>{error}</p>
        <div className="mt-4 flex justify-center gap-4">
          <button
            type="button"
            onClick={retry}
            className="font-medium underline"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="font-medium underline"
          >
            Sign out
          </button>
        </div>
      </FullScreenMessage>
    );
  }

  if (!staff) {
    return <FullScreenMessage>Checking your staff account…</FullScreenMessage>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar staff={staff} onSignOut={() => void signOut()} />
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
