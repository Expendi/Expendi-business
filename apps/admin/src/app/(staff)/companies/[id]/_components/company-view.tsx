"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { CompanyDetail } from "@expendi-business/shared";

import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PauseFlow } from "~/components/pause-flow";
import { PayoutsTable } from "~/components/payouts-table";
import {
  cellClass,
  headCellClass,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Table } from "~/components/ui/table";
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
    return <PageLoading label="Loading company…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
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
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {company.name}
      </h1>
      <p className="mt-1 text-sm text-stone-600">
        KRA PIN {company.kraPin ?? "not given"} · signed up{" "}
        {formatNairobiTime(company.createdAt)} ·{" "}
        <span className="font-mono text-xs">{company.id}</span>
      </p>
      <p className="mt-4 flex flex-wrap gap-2 text-sm">
        {canAct ? (
          <Link
            href={`/companies/${company.id}/imports`}
            className={secondaryButton}
          >
            Import spreadsheet
          </Link>
        ) : null}
        <Link
          href={`/payouts?companyId=${company.id}`}
          className={secondaryButton}
        >
          Payouts to review
        </Link>
        <Link
          href={`/audit-log?organizationId=${company.id}`}
          className={secondaryButton}
        >
          Audit log
        </Link>
        <Link
          href={`/companies/${company.id}/zoho`}
          className={secondaryButton}
        >
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
      {company.members.length === 0 ? (
        <PageEmpty title="No members yet." />
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          <Table className={tableClass} aria-label="Company members">
            <thead className="bg-muted/50 text-muted-foreground">
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
                <tr
                  key={member.id}
                  className="border-t border-border hover:bg-muted/50"
                >
                  <td className={`${cellClass} min-w-40 max-w-64 break-words`}>
                    {member.name ?? "—"}
                  </td>
                  <td className={`${cellClass} min-w-48 max-w-72 break-all`}>
                    {member.email}
                  </td>
                  <td className={cellClass}>{member.role}</td>
                  <td className={cellClass}>{member.status}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      <h2 className="mt-8 text-base font-semibold">Recent payouts</h2>
      <div className="mt-2">
        {company.recentPayouts.length === 0 ? (
          <PageEmpty title="No payouts yet." />
        ) : (
          <PayoutsTable payouts={company.recentPayouts} showCompany={false} />
        )}
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold tabular-nums">{children}</p>
      </CardContent>
    </Card>
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
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Payouts</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
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
            <p className="text-sm text-stone-500">
              Pausing needs an ops admin.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
