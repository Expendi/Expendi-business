"use client";

import type { JSX, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

import type { DashboardRole } from "~/config/roles";

export interface DashboardCompany {
  organizationId: string;
  name: string;
  role: DashboardRole;
}

interface DashboardContextValue {
  company: DashboardCompany;
  /**
   * Accountants are view-only: no action buttons anywhere. The API refuses
   * their writes regardless (spec §6.14).
   */
  canAct: boolean;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({
  company,
  children,
}: {
  company: DashboardCompany;
  children: ReactNode;
}): JSX.Element {
  const { organizationId, name, role } = company;
  const value = useMemo<DashboardContextValue>(
    () => ({
      company: { organizationId, name, role },
      canAct: role === "admin",
    }),
    [organizationId, name, role],
  );
  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

/** The company being worked in, inside the dashboard shell. */
export function useDashboard(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboard must be used inside DashboardProvider");
  }
  return context;
}
