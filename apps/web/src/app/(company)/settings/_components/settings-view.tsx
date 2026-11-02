"use client";

import type { JSX } from "react";

import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { ApprovalPasskeySettings } from "./approval-passkey-settings";
import { CategorySettings } from "./category-settings";
import { useCompanyDetails } from "./settings-api";

/**
 * Settings (spec §6.14): the company's details, its category list and the
 * admin's approval passkey. Accountants see the details and categories,
 * read-only.
 */
export function SettingsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <section key={company.organizationId} className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-stone-600">
          {canAct
            ? "The company's details, the categories people pick when they record spending, and your approval passkey."
            : "The company's details and the categories people pick when they record spending. Only admins change them."}
        </p>
      </div>
      <CompanyDetails organizationId={company.organizationId} />
      <CategorySettings
        organizationId={company.organizationId}
        canAct={canAct}
      />
      {canAct ? <ApprovalPasskeySettings /> : null}
    </section>
  );
}

function CompanyDetails({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const details = useCompanyDetails(organizationId);
  return (
    <section aria-labelledby="company-heading" className="space-y-3">
      <h2 id="company-heading" className="text-base font-semibold">
        Company
      </h2>
      {details.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : details.isError ? (
        <p className="text-sm text-error-700" role="alert">
          {describeApiError(details.error)}
        </p>
      ) : (
        <div className="max-w-3xl rounded-lg border border-stone-200 bg-white p-4 text-sm">
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-stone-600">Name</dt>
              <dd className="mt-1 font-medium">{details.data.name}</dd>
            </div>
            <div>
              <dt className="text-stone-600">KRA PIN</dt>
              <dd className="mt-1 font-mono">
                {details.data.kraPin ?? "Not given"}
              </dd>
            </div>
            <div>
              <dt className="text-stone-600">Your role</dt>
              <dd className="mt-1 font-medium">
                {ROLE_LABELS[details.data.role]}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-stone-600">
            Set when the company signed up. They can&apos;t be changed here.
          </p>
        </div>
      )}
    </section>
  );
}
