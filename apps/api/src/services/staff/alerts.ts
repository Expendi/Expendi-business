import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  OpsAlert,
  OpsAlertEmailStatus,
  OpsAlertKind,
  OpsAlertsResponse,
  SystemHealth,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { OpsAlertDetail } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { query } from "../../db/scope.js";
import {
  PRETIUM_RECONCILE_JOB,
  RECONCILE_JOB,
  RECONCILIATION_STALE_MINUTES,
  WEBHOOK_QUIET_MINUTES,
} from "../alerts/alert-checks.js";
import { isoUtc } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The admin app's alerts and system health (spec §6.16). Read-only: an
 * alert opens and resolves on its own, so staff only look. Incidents come
 * from the `staff_ops_alerts` definer function, in a read scope with no
 * company or user: the only scope `ops_alerts` shows rows to.
 */

/** Resolved alerts stay on the alerts page this long. */
export const RESOLVED_SHOWN_DAYS = 7;
export const ALERTS_SHOWN = 200;

const DAY_MS = 24 * 60 * 60_000;

interface AlertRow extends Record<string, unknown> {
  readonly alert_id: string;
  readonly kind: OpsAlertKind;
  readonly subject_key: string;
  readonly organization_id: string | null;
  readonly organization_name: string | null;
  readonly title: string;
  readonly details: readonly OpsAlertDetail[];
  readonly occurrences: number;
  readonly opened_at: string;
  readonly last_seen_at: string;
  readonly resolved_at: string | null;
  readonly notified_at: string | null;
  readonly notify_attempts: number;
  readonly next_notify_at: string;
  readonly last_notify_error: string | null;
}

/** Open first, newest first; then resolved, most recently resolved first. */
function readAlerts(
  tx: Transaction,
  input: {
    readonly kind: OpsAlertKind | null;
    readonly resolvedSince: string | null;
    readonly maxRows: number;
  },
): Effect.Effect<readonly AlertRow[], DatabaseError> {
  return query(() =>
    tx.execute<AlertRow>(sql`
      SELECT a.alert_id, a.kind, a.subject_key, a.organization_id,
             a.organization_name, a.title, a.details, a.occurrences,
             ${isoUtc(sql`a.opened_at`)} AS opened_at,
             ${isoUtc(sql`a.last_seen_at`)} AS last_seen_at,
             ${isoUtc(sql`a.resolved_at`)} AS resolved_at,
             ${isoUtc(sql`a.notified_at`)} AS notified_at,
             a.notify_attempts,
             ${isoUtc(sql`a.next_notify_at`)} AS next_notify_at,
             a.last_notify_error
      FROM staff_ops_alerts(
        ${input.kind}::ops_alert_kind,
        ${input.resolvedSince}::timestamptz,
        ${input.maxRows}::integer
      ) AS a`),
  ).pipe(Effect.map(({ rows }) => rows));
}

function emailStatus(row: AlertRow): OpsAlertEmailStatus {
  if (row.notified_at) return "sent";
  if (row.resolved_at) return "not_sent";
  return row.last_notify_error ? "retrying" : "pending";
}

function fromAlertRow(row: AlertRow): OpsAlert {
  const status = emailStatus(row);
  return {
    id: row.alert_id,
    kind: row.kind,
    subjectKey: row.subject_key,
    organization:
      row.organization_id && row.organization_name
        ? { id: row.organization_id, name: row.organization_name }
        : null,
    title: row.title,
    details: row.details.map(({ label, value }) => ({ label, value })),
    occurrences: row.occurrences,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    email: {
      status,
      sentAt: row.notified_at,
      attempts: row.notify_attempts,
      lastError: row.last_notify_error,
      nextAttemptAt:
        status === "pending" || status === "retrying"
          ? row.next_notify_at
          : null,
    },
  };
}

/** Every open alert, then those resolved in the last 7 days. */
export function listOpsAlerts(
  now: Date = new Date(),
): Effect.Effect<OpsAlertsResponse, DatabaseError, DatabaseService> {
  const resolvedSince = new Date(
    now.getTime() - RESOLVED_SHOWN_DAYS * DAY_MS,
  ).toISOString();
  return withStaffReadScope({}, (tx) =>
    readAlerts(tx, { kind: null, resolvedSince, maxRows: ALERTS_SHOWN + 1 }),
  ).pipe(
    Effect.map((rows) => {
      const alerts = rows.slice(0, ALERTS_SHOWN).map(fromAlertRow);
      return {
        open: alerts.filter((alert) => alert.resolvedAt === null),
        recentlyResolved: alerts.filter((alert) => alert.resolvedAt !== null),
        resolvedSince,
        truncated: rows.length > ALERTS_SHOWN,
      };
    }),
  );
}

interface ClockRow extends Record<string, unknown> {
  readonly checked_at: string;
}

interface ReconciliationRow extends Record<string, unknown> {
  readonly job: string;
  readonly last_finished_at: string;
  readonly stale: boolean;
}

interface HeartbeatRow extends Record<string, unknown> {
  readonly job: string;
  readonly last_finished_at: string;
}

type ReconciliationHealth = SystemHealth["reconciliation"];
type WebhookHealth = SystemHealth["paycrestWebhook"];

/** A job that has never finished a run counts as stopped. */
function reconciliationHealth(
  job: string,
  rows: readonly ReconciliationRow[],
): ReconciliationHealth {
  const row = rows.find((candidate) => candidate.job === job);
  return {
    job,
    lastFinishedAt: row?.last_finished_at ?? null,
    staleAfterMinutes: RECONCILIATION_STALE_MINUTES,
    stale: row?.stale ?? true,
  };
}

/** The source's open incident, or else its latest; `incidents` come open first, newest first. */
function webhookHealth(
  source: "paycrest" | "pretium",
  incidents: readonly AlertRow[],
): WebhookHealth {
  const incident = incidents.find((row) => row.subject_key === source);
  return {
    resolvesAfterQuietMinutes: WEBHOOK_QUIET_MINUTES,
    signatureFailures: incident
      ? {
          alertId: incident.alert_id,
          open: incident.resolved_at === null,
          count: incident.occurrences,
          firstSeenAt: incident.opened_at,
          lastSeenAt: incident.last_seen_at,
          resolvedAt: incident.resolved_at,
        }
      : null,
  };
}

/**
 * Each cash-out provider's last finished reconciliation run, judged on the
 * database's clock as the "reconciliation stopped" alert judges it; each
 * provider webhook's latest signature-failure incident; and every station
 * job's heartbeat.
 */
export function systemHealth(): Effect.Effect<
  SystemHealth,
  DatabaseError,
  DatabaseService
> {
  return withStaffReadScope({}, (tx) =>
    Effect.gen(function* () {
      const {
        rows: [clock],
      } = yield* query(() =>
        tx.execute<ClockRow>(sql`SELECT ${isoUtc(sql`now()`)} AS checked_at`),
      );
      const { rows: reconciliations } = yield* query(() =>
        tx.execute<ReconciliationRow>(sql`
          SELECT job,
                 ${isoUtc(sql`last_finished_at`)} AS last_finished_at,
                 last_finished_at < now() - make_interval(mins => ${RECONCILIATION_STALE_MINUTES}) AS stale
          FROM station_heartbeats
          WHERE job IN (${RECONCILE_JOB}, ${PRETIUM_RECONCILE_JOB})`),
      );
      // Every source shares the alert kind; the most a read returns is
      // enough to find each source's latest incident.
      const webhookIncidents = yield* readAlerts(tx, {
        kind: "webhook_signature_failure",
        resolvedSince: null,
        maxRows: ALERTS_SHOWN + 1,
      });
      const { rows: jobs } = yield* query(() =>
        tx.execute<HeartbeatRow>(sql`
          SELECT job, ${isoUtc(sql`last_finished_at`)} AS last_finished_at
          FROM station_heartbeats
          ORDER BY job`),
      );
      return {
        checkedAt: clock?.checked_at ?? new Date().toISOString(),
        reconciliation: reconciliationHealth(RECONCILE_JOB, reconciliations),
        pretiumReconciliation: reconciliationHealth(
          PRETIUM_RECONCILE_JOB,
          reconciliations,
        ),
        paycrestWebhook: webhookHealth("paycrest", webhookIncidents),
        pretiumWebhook: webhookHealth("pretium", webhookIncidents),
        jobs: jobs.map((row) => ({
          job: row.job,
          lastFinishedAt: row.last_finished_at,
        })),
      };
    }),
  );
}
