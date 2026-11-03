"use client";

import { AppSidebar } from "~/components/app-sidebar";
import { Badge } from "~/components/ui/badge";
import { NAV_ITEMS } from "~/config/navigation";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";

export function Sidebar({
  email,
  onSwitchCompany,
  onSignOut,
}: {
  email: string;
  onSwitchCompany: (() => void) | null;
  onSignOut: () => void;
}) {
  const { company, canAct } = useDashboard();
  return (
    <AppSidebar
      title={company.name}
      detail={
        <>
          {ROLE_LABELS[company.role]}
          {canAct ? null : <Badge variant="secondary">View only</Badge>}
        </>
      }
      role={ROLE_LABELS[company.role]}
      email={email}
      items={NAV_ITEMS}
      onSwitchCompany={onSwitchCompany}
      onSignOut={onSignOut}
    />
  );
}
