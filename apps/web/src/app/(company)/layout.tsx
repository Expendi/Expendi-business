"use client";

import type { JSX, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { TreasuryOfferProvider } from "~/app/(company)/wallet/_components/treasury-offer";
import { AppShell } from "~/components/app-shell";
import { CompanyPicker } from "~/components/company-picker";
import { FullNameStep } from "~/components/full-name-step";
import { FullScreenMessage } from "~/components/full-screen-message";
import { SessionNotice } from "~/components/session-notice";
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
      <TreasuryOfferProvider>
        <AppShell
          name={me.user.fullName}
          email={me.user.email}
          onSwitchCompany={onSwitchCompany}
          onSignOut={onSignOut}
        >
          {children}
        </AppShell>
      </TreasuryOfferProvider>
    </DashboardProvider>
  );
}
