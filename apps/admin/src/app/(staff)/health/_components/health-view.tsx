"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { SystemHealth } from "@expendi-business/shared";

import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import {
  cellClass,
  headCellClass,
  linkClass,
  tableClass,
} from "~/components/styles";
import { Badge } from "~/components/ui/badge";
import {
  CardContent,
  CardHeader,
  CardTitle,
  Card as Surface,
} from "~/components/ui/card";
import { Table } from "~/components/ui/table";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

const REFRESH_MS = 60_000;

/** Measured against the database's clock, which the API reports, not the browser's. */
function minutesAgo(iso: string, checkedAt: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(checkedAt) - Date.parse(iso)) / 60_000),
  );
  if (minutes === 0) return "less than a minute ago";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

/**
 * The station jobs and the Paycrest webhook (spec §6.16): what the
 * "reconciliation stopped" and "webhook signature failure" alerts watch.
 */
export function HealthView() {
  const { api } = useStaffAuth();
  const result = useQuery({
    queryKey: queryKeys.systemHealth(),
    queryFn: () => api.alerts.health(),
    refetchInterval: REFRESH_MS,
  });

  return (
    <section className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
      {result.isPending ? (
        <PageLoading label="Loading system health…" />
      ) : result.isError ? (
        <PageError>{describeApiError(result.error)}</PageError>
      ) : (
        <>
          <p className="mt-1 text-sm text-stone-600">
            Checked {formatNairobiTime(result.data.checkedAt)}. Open problems
            are also on{" "}
            <Link href="/alerts" className={linkClass}>
              Alerts
            </Link>
            .
          </p>
          <Reconciliation health={result.data} />
          <PaycrestWebhook health={result.data} />
          <Jobs health={result.data} />
        </>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Surface className="mt-6">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Surface>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      variant={ok ? "secondary" : "destructive"}
      className={ok ? "bg-emerald-50 text-emerald-800" : undefined}
    >
      {label}
    </Badge>
  );
}

function Reconciliation({ health }: { health: SystemHealth }) {
  const { reconciliation, checkedAt } = health;
  return (
    <Card title="Payout reconciliation">
      <p className="mt-2 text-sm">
        <StatusBadge
          ok={!reconciliation.stale}
          label={reconciliation.stale ? "Stopped" : "Running"}
        />{" "}
        {reconciliation.lastFinishedAt ? (
          <>
            Last finished run {formatNairobiTime(reconciliation.lastFinishedAt)}{" "}
            <span className="text-stone-500">
              ({minutesAgo(reconciliation.lastFinishedAt, checkedAt)})
            </span>
          </>
        ) : (
          "It has never finished a run."
        )}
      </p>
      <p className="mt-2 text-sm text-stone-600">
        Checks payouts against Paycrest every minute. With no finished run in{" "}
        {reconciliation.staleAfterMinutes} minutes, the &ldquo;Reconciliation
        stopped&rdquo; alert fires.
      </p>
    </Card>
  );
}

function PaycrestWebhook({ health }: { health: SystemHealth }) {
  const { signatureFailures, resolvesAfterQuietMinutes } =
    health.paycrestWebhook;
  return (
    <Card title="Paycrest webhook signatures">
      {signatureFailures === null ? (
        <p className="mt-2 text-sm">
          <StatusBadge ok label="No failures" /> No webhook has failed its
          signature check.
        </p>
      ) : signatureFailures.open ? (
        <p className="mt-2 text-sm">
          <StatusBadge ok={false} label="Failing" /> {signatureFailures.count}{" "}
          failed {signatureFailures.count === 1 ? "signature" : "signatures"}{" "}
          since {formatNairobiTime(signatureFailures.firstSeenAt)}; the last{" "}
          {minutesAgo(signatureFailures.lastSeenAt, health.checkedAt)}.
        </p>
      ) : (
        <p className="mt-2 text-sm">
          <StatusBadge ok label="No open failures" /> The last incident had{" "}
          {signatureFailures.count} failed{" "}
          {signatureFailures.count === 1 ? "signature" : "signatures"}, from{" "}
          {formatNairobiTime(signatureFailures.firstSeenAt)} to{" "}
          {formatNairobiTime(signatureFailures.lastSeenAt)}
          {signatureFailures.resolvedAt
            ? `, resolved ${formatNairobiTime(signatureFailures.resolvedAt)}`
            : ""}
          .
        </p>
      )}
      <p className="mt-2 text-sm text-stone-600">
        A failure opens the &ldquo;Webhook signature failure&rdquo; alert. It
        resolves after {resolvesAfterQuietMinutes} minutes without another.
      </p>
    </Card>
  );
}

function Jobs({ health }: { health: SystemHealth }) {
  return (
    <Card title="Station jobs">
      {health.jobs.length === 0 ? (
        <PageEmpty title="No job has recorded a run." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table className={tableClass} aria-label="Station jobs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className={headCellClass}>
                  Job
                </th>
                <th scope="col" className={headCellClass}>
                  Last finished run
                </th>
              </tr>
            </thead>
            <tbody>
              {health.jobs.map((job) => (
                <tr
                  key={job.job}
                  className="border-t border-border hover:bg-muted/50"
                >
                  <td className={`${cellClass} font-mono text-xs`}>
                    {job.job}
                  </td>
                  <td className={cellClass}>
                    {formatNairobiTime(job.lastFinishedAt)}{" "}
                    <span className="text-stone-500">
                      ({minutesAgo(job.lastFinishedAt, health.checkedAt)})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
