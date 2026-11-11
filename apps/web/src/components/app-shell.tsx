"use client";

import type { CSSProperties, JSX, ReactNode } from "react";
import { cn } from "cn";
import { usePathname } from "next/navigation";

import type { Account } from "~/components/shell/account-menu";
import { AppSidebar } from "~/components/app-sidebar";
import { SiteHeader } from "~/components/site-header";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { useNavCounts } from "~/hooks/use-nav-counts";
import { useSidebarDefaultOpen } from "~/stores/preferences/preferences-provider";

/**
 * The dashboard frame from the shadcn admin template: a collapsible
 * sidebar, a 48px header and the page, centered or full width. The layout
 * controls in the header change all three. A page can set
 * `data-content-padding="false"` on its root to go edge to edge.
 */
export function AppShell({
  name,
  email,
  onSwitchCompany,
  onSignOut,
  currentPath,
  children,
}: {
  name: string | null;
  email: string;
  onSwitchCompany: (() => void) | null;
  onSignOut: () => void;
  /** The page to mark current; defaults to the URL's. */
  currentPath?: string;
  children: ReactNode;
}): JSX.Element {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const { company } = useDashboard();
  const counts = useNavCounts(company.organizationId);
  const defaultOpen = useSidebarDefaultOpen();
  const account: Account = {
    name,
    email,
    role: ROLE_LABELS[company.role],
    companyName: company.name,
    onSwitchCompany,
    onSignOut,
  };

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        { "--sidebar-width": "calc(var(--spacing) * 68)" } as CSSProperties
      }
    >
      <AppSidebar path={path} counts={counts} account={account} />
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
          className="app-content @container/main flex min-h-0 w-full min-w-0 flex-1 flex-col gap-6 p-4 pb-12 has-data-[content-padding=false]:p-0 md:p-6 md:pb-14 md:has-data-[content-padding=false]:p-0"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
