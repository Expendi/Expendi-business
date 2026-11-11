import type { JSX } from "react";
import { Redirect, Tabs } from "expo-router";

import type { TabItem } from "~/components/tab-bar";
import type { CompanyState } from "~/features/company/company-provider";
import { LoadingScreen } from "~/components/loading-screen";
import { TabBar } from "~/components/tab-bar";
import { AccountErrorScreen } from "~/features/company/account-error-screen";
import { useCompanySession } from "~/features/company/company-provider";
import { ADMIN_TABS, MEMBER_TABS } from "~/features/company/tabs";
import { FullNameStep } from "~/features/me/full-name-step";

/** Paycrest pays in the person's name, so it comes before anything else (spec §6.2). */
function needsFullName(state: CompanyState): boolean {
  return "me" in state && state.me.user.fullName === null;
}

export default function AppLayout(): JSX.Element {
  const { state, retry } = useCompanySession();

  if (needsFullName(state)) return <FullNameStep />;

  switch (state.status) {
    case "loading":
      return <LoadingScreen label="Loading your account" />;
    case "error":
      return <AccountErrorScreen error={state.error} onRetry={retry} />;
    case "no-company":
      return <Redirect href="/create-company" />;
    case "choose":
      return <Redirect href="/select-company" />;
    case "ready":
      return (
        <AppTabs
          tabs={state.company.role === "admin" ? ADMIN_TABS : MEMBER_TABS}
        />
      );
  }
}

/** Every tab route is registered; the role decides which ones the bar shows. */
function AppTabs({ tabs }: { tabs: readonly TabItem[] }): JSX.Element {
  const visible = new Set(tabs.map((tab) => tab.name));
  const hiddenUnlessVisible = (name: string) =>
    visible.has(name) ? {} : { href: null };
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} tabs={tabs} />}
    >
      {[...ADMIN_TABS, ...MEMBER_TABS]
        .filter(
          (tab, index, all) =>
            all.findIndex((other) => other.name === tab.name) === index,
        )
        .map((tab) => (
          <Tabs.Screen
            key={tab.name}
            name={tab.name}
            options={hiddenUnlessVisible(tab.name)}
          />
        ))}
    </Tabs>
  );
}
