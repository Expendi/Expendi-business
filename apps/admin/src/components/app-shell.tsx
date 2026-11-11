"use client";

import type { CSSProperties, JSX, ReactNode } from "react";
import { cn } from "cn";
import { usePathname } from "next/navigation";

import type { Account } from "~/components/shell/account-menu";
import { AppSidebar } from "~/components/app-sidebar";
import { SiteHeader } from "~/components/site-header";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { useSidebarDefaultOpen } from "~/stores/preferences/preferences-provider";

/**
 * The staff frame from the shadcn admin template: a collapsible sidebar, a
 * 48px header and the page, centered or full width. The layout controls in
 * the header change all three.
 */
export function AppShell({
  email,
  role,
  onSignOut,
  currentPath,
  children,
}: {
  email: string;
  role: string;
  onSignOut: () => void;
  /** The page to mark current; defaults to the URL's. */
  currentPath?: string;
  children: ReactNode;
}): JSX.Element {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const defaultOpen = useSidebarDefaultOpen();
  const account: Account = { email, role, onSignOut };

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        { "--sidebar-width": "calc(var(--spacing) * 68)" } as CSSProperties
      }
    >
      <AppSidebar path={path} account={account} />
      <SidebarInset
        className={cn(
          "[html[data-content-layout=centered]_&>*]:mx-auto [html[data-content-layout=centered]_&>*]:w-full [html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
          "peer-data-[variant=inset]:border",
          "min-w-0 overflow-x-clip",
        )}
      >
        <SiteHeader path={path} account={account} />
        <main
          id="main-content"
          className="app-content @container/main flex min-h-0 w-full min-w-0 flex-1 flex-col gap-6 p-4 pb-12 md:p-6 md:pb-14"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
