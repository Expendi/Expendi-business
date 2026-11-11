"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import type { StaffPayoutDetail } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PayoutStatusBadge } from "~/components/payout-status";
import { subjectLabel } from "~/components/payouts-table";
import { linkClass, secondaryButton } from "~/components/styles";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import { ledgerColumns } from "./columns";
import { ResolveFlow } from "./resolve-flow";

const time = (iso: string | null) => (iso ? formatNairobiTime(iso) : "—");
const usdc = (units: string | null) => (units ? formatUsdc(units) : "—");

/** One payout, with what's needed to check it against Paycrest and the chain. */
export function PayoutView({ payoutId }: { payoutId: string }) {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const result = useQuery({
    queryKey: queryKeys.payout(payoutId),
    queryFn: () => api.ops.payout(payoutId),
  });

  if (result.isPending) {
    return <PageLoading label="Loading payout…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }
  const payout = result.data;
  const auditHref = `/audit-log?entityType=payout&entityId=${payout.id}`;

  return (
    <section className="max-w-5xl">
      <p className="text-sm">
        <Link
          href="/payouts"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Payouts
        </Link>
      </p>
      <div className="mt-2">
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-3">
              <span>
                {payout.method === "usdc" && payout.amountToTransferUsdc
                  ? formatUsdc(payout.amountToTransferUsdc)
                  : formatKesCents(payout.amountKesCents)}{" "}
                to {payout.recipient.name}
              </span>
              <PayoutStatusBadge status={payout.status} />
            </span>
          }
          subtitle={
            <>
              <Link
                href={`/companies/${payout.organization.id}`}
                className={linkClass}
              >
                {payout.organization.name}
              </Link>{" "}
              · {subjectLabel(payout)} · {payout.method.replace("_", " ")} via{" "}
              {payout.provider} ·{" "}
              <Link href={auditHref} className={linkClass}>
                Audit trail
              </Link>
            </>
          }
        />
      </div>
      {payout.failureReason ? (
        <p className="mt-3 rounded-md bg-warn-50 px-3 py-2 text-sm">
          {payout.failureReason}
        </p>
      ) : null}

      <PayoutActions payout={payout} canAct={canAct} />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2>Details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_minmax(0,1fr)]">
            {(
              [
                ["Payout ID", payout.id],
                [
                  "Recipient",
                  `${payout.recipient.name}, ${payout.recipient.detail}`,
                ],
                ["Paycrest order", payout.providerOrderId ?? "—"],
                [
                  "Paycrest status",
                  payout.providerStatus
                    ? `${payout.providerStatus} (checked ${time(payout.providerCheckedAt)})`
                    : "—",
                ],
                ["Gateway order", payout.gatewayOrderId ?? "—"],
                ["Deposit address", payout.depositAddress ?? "—"],
                ["Deposit valid until", time(payout.depositValidUntil)],
                ["Company wallet", payout.walletAddress ?? "—"],
                ["Amount to send", usdc(payout.amountToTransferUsdc)],
                ["Most it may debit", usdc(payout.maxDebitUsdc)],
                ["Rate", payout.rate ?? "—"],
                ["Transaction hash", payout.txHash ?? "—"],
                ["Privy transaction", payout.privyTransactionId ?? "—"],
                ["M-Pesa or bank reference", payout.providerReference ?? "—"],
                ["Created", time(payout.createdAt)],
                ["Approved", time(payout.approvedAt)],
                ["Funding started", time(payout.fundingStartedAt)],
                ["Paid", time(payout.paidAt)],
                ["Last change", time(payout.updatedAt)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>
            <h2>Ledger</h2>
          </CardTitle>
        </CardHeader>
        {payout.ledger.length === 0 ? (
          <PageEmpty title="No ledger entries.">
            Nothing has been debited or refunded for this payout.
          </PageEmpty>
        ) : (
          <LedgerTable rows={payout.ledger} />
        )}
      </Card>

      <Card className="mt-6 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>
            <h2>Audit trail</h2>
          </CardTitle>
        </CardHeader>
        {payout.auditTrail.length === 0 ? (
          <PageEmpty title="No audit entries yet." />
        ) : (
          <ol className="divide-y divide-border px-4 text-sm sm:px-6">
            {payout.auditTrail.map((entry) => (
              <li key={entry.id} className="py-4 break-words">
                <span className="text-muted-foreground">
                  {formatNairobiTime(entry.occurredAt)}
                </span>{" "}
                <span className="font-mono text-xs">{entry.action}</span> by{" "}
                {entry.actor.email ?? entry.actor.id}
              </li>
            ))}
          </ol>
        )}
      </Card>
      <p className="mt-2 text-sm">
        <Link href={auditHref} className={linkClass}>
          Open in the audit log, with before and after
        </Link>
      </p>
    </section>
  );
}

function PayoutActions({
  payout,
  canAct,
}: {
  payout: StaffPayoutDetail;
  canAct: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const refetch = useMutation({
    mutationFn: () => api.ops.refetchPayout(payout.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["internal"] }),
  });

  if (!canAct) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Re-fetching and resolving need an ops admin.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {payout.provider === "paycrest" && payout.providerOrderId ? (
        <div>
          <button
            type="button"
            onClick={() => refetch.mutate()}
            disabled={refetch.isPending}
            className={secondaryButton}
          >
            {refetch.isPending ? "Asking Paycrest…" : "Re-fetch from Paycrest"}
          </button>
          {refetch.isSuccess ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Paycrest says {refetch.data.paycrestStatus}.{" "}
              {refetch.data.status === refetch.data.previousStatus
                ? "The payout is unchanged."
                : `The payout moved from ${refetch.data.previousStatus} to ${refetch.data.status}.`}
            </p>
          ) : null}
          {refetch.isError ? (
            <p role="alert" className="mt-2 text-sm text-error-700">
              {describeApiError(refetch.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {payout.status === "needs_review" ? (
        <ResolveFlow payoutId={payout.id} />
      ) : null}
    </div>
  );
}

function LedgerTable({ rows }: { rows: StaffPayoutDetail["ledger"] }) {
  const table = useDataTable({
    data: rows,
    columns: ledgerColumns,
    getRowId: (row) => row.id,
    manual: true,
    paginate: false,
  });
  return <DataTable table={table} caption="Payout ledger" />;
}
