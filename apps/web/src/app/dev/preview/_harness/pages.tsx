import type { ComponentType } from "react";

import { ActivityView } from "~/app/(company)/activity/_components/activity-view";
import { ApprovalsView } from "~/app/(company)/approvals/_components/approvals-view";
import { BillsView } from "~/app/(company)/bills/_components/bills-view";
import { ExpensesView } from "~/app/(company)/expenses/_components/expenses-view";
import { OverviewView } from "~/app/(company)/overview/_components/overview-view";
import { PayeesView } from "~/app/(company)/payees/_components/payees-view";
import { PayrollView } from "~/app/(company)/payroll/_components/payroll-view";
import { ReportsView } from "~/app/(company)/reports/_components/reports-view";
import { SettingsView } from "~/app/(company)/settings/_components/settings-view";
import { TeamView } from "~/app/(company)/team/_components/team-view";
import { WalletView } from "~/app/(company)/wallet/_components/wallet-view";

export interface PagePreview {
  /** The real route, so the sidebar marks it current. */
  readonly path: string;
  readonly View: ComponentType;
}

/**
 * The pages `/dev/preview/[page]` can show. To add one, import its view
 * here and seed what it reads in `seed.ts`.
 */
export const PAGE_PREVIEWS: Readonly<Record<string, PagePreview>> = {
  activity: { path: "/activity", View: ActivityView },
  approvals: { path: "/approvals", View: ApprovalsView },
  bills: { path: "/bills", View: BillsView },
  expenses: { path: "/expenses", View: ExpensesView },
  overview: { path: "/overview", View: OverviewView },
  payees: { path: "/payees", View: PayeesView },
  payroll: { path: "/payroll", View: PayrollView },
  reports: { path: "/reports", View: ReportsView },
  settings: { path: "/settings", View: SettingsView },
  team: { path: "/team", View: TeamView },
  wallet: { path: "/wallet", View: WalletView },
};
