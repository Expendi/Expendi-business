"use client";

import type { JSX, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { CompanyPicker } from "~/components/company-picker";
import { FullNameStep } from "~/components/full-name-step";
import { FullScreenMessage } from "~/components/full-screen-message";
import { SessionNotice } from "~/components/session-notice";
import { Sidebar } from "~/components/sidebar";
import { SiteHeader } from "~/components/site-header";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { isDashboardRole } from "~/config/roles";
import { useAuth } from "~/contexts/auth-context";
import { useCompanySession } from "~/contexts/company-context";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";

/**
 * Everything between Privy sign-in and the dashboard: `GET /me`, picking a
 * company, turning employees away to the app, and the full name the first
 * time. Only admins and accountants reach the shell.
 */
export default function CompanyLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const router = useRouter();
  const { status, signOut } = useAuth();
  const { state, selectCompany, switchCompany, cancelSwitch, retry } =
    useCompanySession();
  const onSignOut = () => void signOut();

  useEffect(() => {
    if (status === "signed-out" || status === "offering-passkey") {
      router.replace("/");
    }
  }, [status, router]);

  if (status !== "signed-in" || state.status === "loading") {
    return <FullScreenMessage>Loading your account…</FullScreenMessage>;
  }

  if (state.status === "error") {
    return (
      <SessionNotice
        title="Couldn't load your account"
        actions={[
          { label: "Try again", onClick: retry },
          { label: "Sign out", onClick: onSignOut },
        ]}
      >
        <p className="mt-2 text-sm text-stone-600">
          {describeApiError(state.error)}
        </p>
      </SessionNotice>
    );
  }

  if (state.status === "no-company") {
    return (
      <SessionNotice
        title="You're not part of a company on Expendi Business yet"
        actions={[
          { label: "Check again", onClick: retry },
          { label: "Sign out", onClick: onSignOut },
        ]}
      >
        <p className="mt-2 text-sm text-stone-600">
          Ask your company&apos;s admin to invite {state.me.user.email}.
        </p>
      </SessionNotice>
    );
  }

  if (state.status === "choose") {
    return (
      <CompanyPicker
        companies={state.companies}
        currentId={state.currentId}
        onSelect={selectCompany}
        onCancel={state.currentId ? cancelSwitch : null}
        onSignOut={onSignOut}
      />
    );
  }

  const { me, companies, company } = state;
  const onSwitchCompany = companies.length > 1 ? switchCompany : null;

  if (!isDashboardRole(company.role)) {
    return (
      <SessionNotice
        title="Use the Expendi Business app"
        actions={[
          ...(onSwitchCompany
            ? [{ label: "Switch company", onClick: onSwitchCompany }]
            : []),
          { label: "Sign out", onClick: onSignOut },
        ]}
      />
    );
  }

  if (me.user.fullName === null) return <FullNameStep />;

  return (
    <DashboardProvider company={{ ...company, role: company.role }}>
      <SidebarProvider>
        <Sidebar
          email={me.user.email}
          onSwitchCompany={onSwitchCompany}
          onSignOut={onSignOut}
        />
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
    </DashboardProvider>
  );
}
