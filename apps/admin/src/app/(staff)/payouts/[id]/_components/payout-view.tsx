"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import type { StaffPayoutDetail } from "@expendi-business/shared";

import { PayoutStatusBadge } from "~/components/payout-status";
import { subjectLabel } from "~/components/payouts-table";
import {
  cellClass,
  headCellClass,
  linkClass,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
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
    return <p className="text-sm text-stone-500">Loading…</p>;
  }
  if (result.isError) {
    return (
      <p role="alert" className="text-sm text-error-700">
        {describeApiError(result.error)}
      </p>
    );
  }
  const payout = result.data;
  const auditHref = `/audit-log?entityType=payout&entityId=${payout.id}`;

  return (
    <section className="max-w-5xl">
      <p className="text-sm">
        <Link
          href="/payouts"
          className="text-stone-600 underline-offset-4 hover:underline"
        >
          Payouts
        </Link>
      </p>
      <h1 className="mt-1 flex items-center gap-3 text-xl font-semibold">
        {payout.method === "usdc" && payout.amountToTransferUsdc
          ? formatUsdc(payout.amountToTransferUsdc)
          : formatKesCents(payout.amountKesCents)}{" "}
        to {payout.recipient.name}
        <PayoutStatusBadge status={payout.status} />
      </h1>
      <p className="mt-1 text-sm text-stone-600">
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
      </p>
      {payout.failureReason ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">
          {payout.failureReason}
        </p>
      ) : null}

      <PayoutActions payout={payout} canAct={canAct} />

      <h2 className="mt-8 text-base font-semibold">Details</h2>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-stone-200 bg-white p-4 text-sm sm:grid-cols-[14rem_1fr]">
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
            <dt className="text-stone-500">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-8 text-base font-semibold">Ledger</h2>
      {payout.ledger.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">
          No ledger rows: nothing has been debited or refunded for it.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className={tableClass}>
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th scope="col" className={headCellClass}>
                  When
                </th>
                <th scope="col" className={headCellClass}>
                  Type
                </th>
                <th scope="col" className={headCellClass}>
                  Amount
                </th>
                <th scope="col" className={headCellClass}>
                  Transaction
                </th>
              </tr>
            </thead>
            <tbody>
              {payout.ledger.map((row) => (
                <tr key={row.id} className="border-t border-stone-200">
                  <td className={cellClass}>{time(row.createdAt)}</td>
                  <td className={cellClass}>{row.type}</td>
                  <td className={cellClass}>{formatUsdc(row.usdcAmount)}</td>
                  <td className={`${cellClass} font-mono text-xs break-all`}>
                    {row.txHash ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 text-base font-semibold">Audit trail</h2>
      <ol className="mt-2 space-y-1 text-sm">
        {payout.auditTrail.map((entry) => (
          <li key={entry.id}>
            <span className="text-stone-500">
              {formatNairobiTime(entry.occurredAt)}
            </span>{" "}
            <span className="font-mono text-xs">{entry.action}</span> by{" "}
            {entry.actor.email ?? entry.actor.id}
          </li>
        ))}
      </ol>
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
      <p className="mt-4 text-sm text-stone-500">
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
            <p className="mt-2 text-sm text-stone-600">
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
