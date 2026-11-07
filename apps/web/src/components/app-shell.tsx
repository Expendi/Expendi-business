"use client";

import type { JSX, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AppSidebar } from "~/components/app-sidebar";
import { SiteHeader } from "~/components/site-header";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { useDashboard } from "~/contexts/dashboard-context";
import { useNavCounts } from "~/hooks/use-nav-counts";

const DESKTOP = "(min-width: 900px)";

/**
 * The dashboard frame (docs/mocks): a 248px sidebar from 900px; below
 * that, a top bar whose menu button slides the same sidebar in.
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
  const { company } = useDashboard();
  const counts = useNavCounts(company.organizationId);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP);
    const onChange = () => {
      if (desktop.matches) setNavOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  const sidebar = (
    <AppSidebar
      path={currentPath ?? pathname}
      counts={counts}
      name={name}
      email={email}
      onSwitchCompany={
        onSwitchCompany &&
        (() => {
          setNavOpen(false);
          onSwitchCompany();
        })
      }
      onSignOut={onSignOut}
      onNavigate={() => setNavOpen(false)}
    />
  );

  return (
    <div className="flex min-h-dvh text-sm text-gray-900">
      <aside
        aria-label="Main navigation"
        className="sticky top-0 hidden h-dvh w-62 flex-none flex-col border-r border-gray-200 bg-surface min-[900px]:flex"
      >
        {sidebar}
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          overlayClassName="bg-scrim supports-backdrop-filter:backdrop-blur-none"
          className="gap-0 bg-surface p-0 shadow-none data-[side=left]:w-62 data-[side=left]:border-gray-200 data-[side=left]:sm:max-w-none data-open:duration-[250ms] data-open:ease-out-expo"
        >
          <SheetTitle className="sr-only">Main navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <SiteHeader
          companyName={company.name}
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
        />
        <main
          id="main-content"
          className="app-content @container/main mx-auto flex w-full max-w-[1320px] min-w-0 flex-1 flex-col gap-6 px-8 pt-6 pb-18 max-[900px]:px-6 max-[900px]:pt-5 max-[900px]:pb-14 max-[600px]:px-4 max-[600px]:pt-4 max-[600px]:pb-12"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
