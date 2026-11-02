"use client";

import type { JSX } from "react";

import { useDashboard } from "~/contexts/dashboard-context";
import { MarginCard } from "./margin-card";
import { PayrollRunsSection } from "./runs-section";
import { SalariesSection } from "./salaries-section";

/**
 * Payroll (spec §6.21): draft runs with their adjustments, Approve & pay
 * all with one passkey, salaries and the payroll cap. Accountants see
 * everything, salaries included, with no actions (spec §6.14).
 */
export function PayrollView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyPayroll
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyPayroll({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  return (
    <section className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold">Payroll</h1>
        <p className="mt-1 text-sm text-stone-600">
          {canAct
            ? "Check each draft run, change it for this run only, then approve and pay everyone with one passkey. Each person is paid on their own."
            : "Payroll runs, everyone's pay and the payroll cap. Only admins change or pay them."}
        </p>
      </div>
      <PayrollRunsSection organizationId={organizationId} canAct={canAct} />
      <SalariesSection organizationId={organizationId} canAct={canAct} />
      <MarginCard organizationId={organizationId} canAct={canAct} />
    </section>
  );
}
