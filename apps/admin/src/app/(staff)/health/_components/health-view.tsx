"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, ClockIcon, WebhookIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import type { SystemHealth } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { StatCard, StatCards } from "~/components/data/stat-cards";
import { StatusBadge } from "~/components/data/status-badge";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { linkClass } from "~/components/styles";
import {
  CardContent,
  CardHeader,
  CardTitle,
  Card as Surface,
} from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import { jobColumns, minutesAgo } from "./columns";

const REFRESH_MS = 60_000;

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
    <section className="flex max-w-4xl flex-col gap-6">
      <PageHeader title="System health" />
      {result.isPending ? (
        <PageLoading label="Loading system health…" />
      ) : result.isError ? (
        <PageError>{describeApiError(result.error)}</PageError>
      ) : (
        <>
          <p className="-mt-2 text-sm text-muted-foreground">
            Checked {formatNairobiTime(result.data.checkedAt)}. Open problems
            are also on{" "}
            <Link href="/alerts" className={linkClass}>
              Alerts
            </Link>
            .
          </p>
          <HealthFigures health={result.data} />
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
    <Surface>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Surface>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return <StatusBadge tone={ok ? "paid" : "failed"}>{label}</StatusBadge>;
}

function HealthFigures({ health }: { health: SystemHealth }) {
  const { reconciliation, paycrestWebhook, jobs } = health;
  const failing = paycrestWebhook.signatureFailures?.open === true;
  return (
    <StatCards label="Health summary" columns={3}>
      <StatCard
        icon={ActivityIcon}
        tone={reconciliation.stale ? "danger" : "clear"}
        label="Payout reconciliation"
        value={reconciliation.stale ? "Stopped" : "Running"}
      />
      <StatCard
        icon={WebhookIcon}
        tone={failing ? "danger" : "clear"}
        label="Paycrest webhook signatures"
        value={failing ? "Failing" : "No open failures"}
      />
      <StatCard
        icon={ClockIcon}
        tone="total"
        label="Station jobs"
        value={jobs.length}
      />
    </StatCards>
  );
}

function Reconciliation({ health }: { health: SystemHealth }) {
  const { reconciliation, checkedAt } = health;
  return (
    <Card title="Payout reconciliation">
      <p className="mt-2 text-sm">
        <Status
          ok={!reconciliation.stale}
          label={reconciliation.stale ? "Stopped" : "Running"}
        />{" "}
        {reconciliation.lastFinishedAt ? (
          <>
            Last finished run {formatNairobiTime(reconciliation.lastFinishedAt)}{" "}
            <span className="text-muted-foreground">
              ({minutesAgo(reconciliation.lastFinishedAt, checkedAt)})
            </span>
          </>
        ) : (
          "It has never finished a run."
        )}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
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
          <Status ok label="No failures" /> No webhook has failed its signature
          check.
        </p>
      ) : signatureFailures.open ? (
        <p className="mt-2 text-sm">
          <Status ok={false} label="Failing" /> {signatureFailures.count} failed{" "}
          {signatureFailures.count === 1 ? "signature" : "signatures"} since{" "}
          {formatNairobiTime(signatureFailures.firstSeenAt)}; the last{" "}
          {minutesAgo(signatureFailures.lastSeenAt, health.checkedAt)}.
        </p>
      ) : (
        <p className="mt-2 text-sm">
          <Status ok label="No open failures" /> The last incident had{" "}
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
      <p className="mt-2 text-sm text-muted-foreground">
        A failure opens the &ldquo;Webhook signature failure&rdquo; alert. It
        resolves after {resolvesAfterQuietMinutes} minutes without another.
      </p>
    </Card>
  );
}

function Jobs({ health }: { health: SystemHealth }) {
  const columns = useMemo(
    () => jobColumns(health.checkedAt),
    [health.checkedAt],
  );
  const table = useDataTable({
    data: health.jobs,
    columns,
    getRowId: (job) => job.job,
    manual: true,
    paginate: false,
  });
  return (
    <Card title="Station jobs">
      {health.jobs.length === 0 ? (
        <PageEmpty title="No job has recorded a run." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <DataTable table={table} caption="Station jobs" />
        </div>
      )}
    </Card>
  );
}
