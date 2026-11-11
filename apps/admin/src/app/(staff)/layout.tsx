"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AppShell } from "~/components/app-shell";
import { FullScreenMessage } from "~/components/full-screen-message";
import { Button } from "~/components/ui/button";
import { ROLE_LABELS } from "~/config/roles";
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
          <Button type="button" onClick={retry} variant="outline">
            Try again
          </Button>
          <Button
            type="button"
            onClick={() => void signOut()}
            variant="outline"
          >
            Sign out
          </Button>
        </div>
      </FullScreenMessage>
    );
  }

  if (!staff) {
    return <FullScreenMessage>Checking your staff account…</FullScreenMessage>;
  }

  return (
    <AppShell
      email={staff.email}
      role={ROLE_LABELS[staff.role]}
      onSignOut={() => void signOut()}
    >
      {children}
    </AppShell>
  );
}
