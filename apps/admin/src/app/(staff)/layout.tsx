"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { FullScreenMessage } from "~/components/full-screen-message";
import { Sidebar } from "~/components/sidebar";
import { SiteHeader } from "~/components/site-header";
import { Button } from "~/components/ui/button";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
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
    <SidebarProvider>
      <Sidebar staff={staff} onSignOut={() => void signOut()} />
      <SidebarInset className="min-w-0">
        <SiteHeader />
        <main
          id="main-content"
          className="app-content @container/main mx-auto flex w-full min-w-0 max-w-[1440px] flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
