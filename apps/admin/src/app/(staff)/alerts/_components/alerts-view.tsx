"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { OpsAlert, OpsAlertKind } from "@expendi-business/shared";

import {
  cellClass,
  headCellClass,
  linkClass,
  tableClass,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

/** The alert job checks every minute, so the page follows it. */
const REFRESH_MS = 60_000;

const KIND_LABELS: Record<OpsAlertKind, string> = {
  payout_needs_review: "Payout needs review",
  payout_failed: "Payout failed",
  webhook_signature_failure: "Webhook signature failure",
  reconciliation_stopped: "Reconciliation stopped",
  low_company_balance: "Low company balance",
  zoho_sync_failing: "Zoho sync failing",
};

/** Where staff look into an alert's cause. */
function causeLink(alert: OpsAlert): { href: string; label: string } | null {
  switch (alert.kind) {
    case "payout_needs_review":
    case "payout_failed":
      return { href: `/payouts/${alert.subjectKey}`, label: "Open the payout" };
    case "low_company_balance":
      return alert.organization
        ? {
            href: `/companies/${alert.organization.id}`,
            label: "Open the company",
          }
        : null;
    case "zoho_sync_failing":
      return alert.organization
        ? {
            href: `/companies/${alert.organization.id}/zoho`,
            label: "Open Zoho Books",
          }
        : null;
    case "webhook_signature_failure":
    case "reconciliation_stopped":
      return { href: "/health", label: "Open system health" };
  }
}

/**
 * Alerts to the Expendi team (spec §6.16). Read-only: an alert opens when
 * its cause appears and resolves once it clears.
 */
export function AlertsView() {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.opsAlerts(),
    queryFn: () => api.alerts.list(),
    refetchInterval: REFRESH_MS,
  });

  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">Alerts</h1>
      <p className="mt-1 text-sm text-stone-600">
        An alert opens when its cause appears and resolves on its own once the
        cause clears. Each one is emailed to the alert list once.
      </p>

      {result.isPending ? (
        <p className="mt-6 text-sm text-stone-500">Loading…</p>
      ) : result.isError ? (
        <p role="alert" className="mt-6 text-sm text-error-700">
          {describeApiError(result.error)}
        </p>
      ) : (
        <>
          <h2 className="mt-6 text-base font-semibold">
            Open ({result.data.open.length})
          </h2>
          {result.data.open.length === 0 ? (
            <p className="mt-1 text-sm text-stone-500">No open alerts.</p>
          ) : (
            <AlertsTable alerts={result.data.open} />
          )}

          <h2 className="mt-8 text-base font-semibold">
            Resolved since {formatNairobiTime(result.data.resolvedSince)} (
            {result.data.recentlyResolved.length})
          </h2>
          {result.data.recentlyResolved.length === 0 ? (
            <p className="mt-1 text-sm text-stone-500">None.</p>
          ) : (
            <AlertsTable alerts={result.data.recentlyResolved} />
          )}
          {result.data.truncated ? (
            <p className="mt-2 text-sm text-stone-500">
              Showing the latest alerts only; older resolved ones are left out.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function AlertsTable({ alerts }: { alerts: readonly OpsAlert[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Alert
            </th>
            <th scope="col" className={headCellClass}>
              Company
            </th>
            <th scope="col" className={headCellClass}>
              When
            </th>
            <th scope="col" className={headCellClass}>
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertRow({ alert }: { alert: OpsAlert }) {
  const cause = causeLink(alert);
  return (
    <tr className="border-t border-stone-200 align-top">
      <td className={`${cellClass} max-w-md`}>
        <span className="block text-xs font-medium tracking-wide text-stone-500 uppercase">
          {KIND_LABELS[alert.kind]}
        </span>
        <span className="block font-medium">{alert.title}</span>
        {alert.details.length > 0 ? (
          <dl className="mt-1 space-y-0.5 text-xs text-stone-600">
            {alert.details.map((detail, index) => (
              <div key={`${detail.label}-${index}`}>
                <dt className="inline font-medium">{detail.label}: </dt>
                <dd className="inline break-words">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {cause ? (
          <Link href={cause.href} className={`${linkClass} mt-1 inline-block`}>
            {cause.label}
          </Link>
        ) : null}
      </td>
      <td className={cellClass}>
        {alert.organization ? (
          <Link
            href={`/companies/${alert.organization.id}`}
            className="underline-offset-4 hover:underline"
          >
            {alert.organization.name}
          </Link>
        ) : (
          <span className="text-stone-500">All companies</span>
        )}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        <span className="block">
          Opened {formatNairobiTime(alert.openedAt)}
        </span>
        {alert.occurrences > 1 ? (
          <span className="block text-xs text-stone-600">
            Seen {alert.occurrences} times, last{" "}
            {formatNairobiTime(alert.lastSeenAt)}
          </span>
        ) : null}
        {alert.resolvedAt ? (
          <span className="block text-xs text-stone-600">
            Resolved {formatNairobiTime(alert.resolvedAt)}
          </span>
        ) : null}
      </td>
      <td className={`${cellClass} max-w-xs`}>
        <EmailStatus email={alert.email} />
      </td>
    </tr>
  );
}

function EmailStatus({ email }: { email: OpsAlert["email"] }) {
  switch (email.status) {
    case "sent":
      return (
        <span className="text-xs">
          Sent{email.sentAt ? ` ${formatNairobiTime(email.sentAt)}` : ""}
        </span>
      );
    case "pending":
      return <span className="text-xs text-stone-600">Not sent yet</span>;
    case "retrying":
      return (
        <span className="text-xs text-error-700">
          Failed {email.attempts} {email.attempts === 1 ? "time" : "times"}
          {email.lastError ? `: ${email.lastError}` : ""}
          {email.nextAttemptAt ? (
            <span className="block text-stone-600">
              Next try {formatNairobiTime(email.nextAttemptAt)}
            </span>
          ) : null}
        </span>
      );
    case "not_sent":
      return (
        <span className="text-xs text-stone-600">Not sent: resolved first</span>
      );
  }
}
