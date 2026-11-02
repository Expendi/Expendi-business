"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { CompanyDetail } from "@expendi-business/shared";

import { PauseFlow } from "~/components/pause-flow";
import { PayoutsTable } from "~/components/payouts-table";
import {
  cellClass,
  headCellClass,
  linkClass,
  tableClass,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

/** One company, as the Expendi team sees it (spec §6.15). Read-only except the pause. */
export function CompanyView({ companyId }: { companyId: string }) {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const result = useQuery({
    queryKey: queryKeys.company(companyId),
    queryFn: () => api.ops.company(companyId),
  });

  if (result.isPending) {
    return <p className="text-sm text-stone-500">Loading…</p>;
  }
  if (result.isError) {
    return (
      <p role="alert" className="text-sm text-error-700">
        {describeApiError(result.error)}
      </p>
    );
  }
  const company = result.data;

  return (
    <section className="max-w-5xl">
      <p className="text-sm">
        <Link
          href="/companies"
          className="text-stone-600 underline-offset-4 hover:underline"
        >
          Companies
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold">{company.name}</h1>
      <p className="mt-1 text-sm text-stone-600">
        KRA PIN {company.kraPin ?? "not given"} · signed up{" "}
        {formatNairobiTime(company.createdAt)} ·{" "}
        <span className="font-mono text-xs">{company.id}</span>
      </p>
      <p className="mt-2 flex flex-wrap gap-4 text-sm">
        <Link href={`/payouts?companyId=${company.id}`} className={linkClass}>
          Payouts to review
        </Link>
        <Link
          href={`/audit-log?organizationId=${company.id}`}
          className={linkClass}
        >
          Audit log
        </Link>
        <Link href={`/companies/${company.id}/zoho`} className={linkClass}>
          Zoho Books
        </Link>
      </p>

      <PauseSection company={company} canAct={canAct} />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Wallet balance (ledger)">
          {company.wallet ? (
            <>
              {formatUsdc(company.wallet.usdcBalance)}
              <span className="block text-sm font-normal text-stone-600">
                {company.wallet.kesEquivalent
                  ? `≈ ${formatKesCents(company.wallet.kesEquivalent.kesCents)} at ${company.wallet.kesEquivalent.rate}`
                  : "KES equivalent unavailable"}
              </span>
            </>
          ) : (
            "No wallet yet"
          )}
        </Stat>
        <Stat label="Daily payout cap">
          {formatKesCents(company.dailyPayoutCapKesCents)}
        </Stat>
        <Stat label="Unpaid claims">
          {company.unpaidClaims.count}
          <span className="block text-sm font-normal text-stone-600">
            {formatKesCents(company.unpaidClaims.totalKesCents)}
          </span>
        </Stat>
      </div>
      {company.wallet?.address ? (
        <p className="mt-2 text-sm text-stone-600">
          Wallet{" "}
          <span className="font-mono text-xs break-all">
            {company.wallet.address}
          </span>{" "}
          ({company.wallet.status})
        </p>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">Members</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className={tableClass}>
          <thead className="bg-stone-100 text-stone-600">
            <tr>
              <th scope="col" className={headCellClass}>
                Name
              </th>
              <th scope="col" className={headCellClass}>
                Email
              </th>
              <th scope="col" className={headCellClass}>
                Role
              </th>
              <th scope="col" className={headCellClass}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {company.members.map((member) => (
              <tr key={member.id} className="border-t border-stone-200">
                <td className={cellClass}>{member.name ?? "—"}</td>
                <td className={cellClass}>{member.email}</td>
                <td className={cellClass}>{member.role}</td>
                <td className={cellClass}>{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-base font-semibold">Recent payouts</h2>
      <div className="mt-2">
        {company.recentPayouts.length === 0 ? (
          <p className="text-sm text-stone-500">No payouts yet.</p>
        ) : (
          <PayoutsTable payouts={company.recentPayouts} showCompany={false} />
        )}
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{children}</p>
    </div>
  );
}

function PauseSection({
  company,
  canAct,
}: {
  company: CompanyDetail;
  canAct: boolean;
}) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="text-base font-semibold">Payouts</h2>
      <p className="mt-1 text-sm">
        {company.payoutsPaused
          ? "Paused for this company."
          : "Running for this company."}
        {company.platformPayoutsPaused
          ? " All companies' payouts are paused too (Controls)."
          : null}
      </p>
      <div className="mt-3">
        {canAct ? (
          company.payoutsPaused ? (
            <PauseFlow
              action="unpause"
              organizationId={company.id}
              label={`Unpause ${company.name}'s payouts`}
            />
          ) : (
            <PauseFlow
              action="pause"
              organizationId={company.id}
              label={`Pause ${company.name}'s payouts`}
            />
          )
        ) : (
          <p className="text-sm text-stone-500">Pausing needs an ops admin.</p>
        )}
      </div>
    </div>
  );
}
