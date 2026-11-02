import { and, asc, eq, isNull, lte, notInArray, sql } from "drizzle-orm";
import { Config, Effect } from "effect";
import { z } from "zod";

import type { DatabaseService } from "../../db/client.js";
import type {
  OpsAlertDetail,
  OpsAlertKind,
  OpsAlertRow,
} from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import { opsAlerts, stationHeartbeats } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { EmailSender } from "../email/email-sender.js";
import { opsAlertEmail } from "../email/ops-alert-email.js";

/**
 * Alerts to the Expendi team (spec §6.16). A check reports what is wrong
 * now; an incident opens the first time, stays open while it's reported and
 * resolves once it isn't. Each incident emails the alert list once:
 *
 * - the database allows one open incident per alert and subject, so a
 *   repeat check or a second API instance opens nothing more
 * - a sender claims an incident's email before sending it, so no other
 *   sender takes it meanwhile
 * - each email carries an idempotency key, so a send retried after a crash
 *   still arrives once
 *
 * Without `ALERT_EMAILS` an alert is logged instead of emailed.
 */

export interface AlertSignal {
  readonly kind: OpsAlertKind;
  readonly subjectKey: string;
  readonly organizationId: string | null;
  readonly title: string;
  readonly details: readonly OpsAlertDetail[];
}

export interface CheckResult {
  readonly kind: OpsAlertKind;
  /** What is wrong now: each opens an incident unless one is open. */
  readonly firing: readonly AlertSignal[];
  /**
   * Subjects whose open incident stays as it is: the check couldn't tell
   * this time, or the incident is raised elsewhere and still recent.
   */
  readonly keep: readonly string[];
}

const SYSTEM_SCOPE = {} as const;

/**
 * Opens what's newly firing and resolves what no longer is, for one check.
 * Returns how many incidents opened and resolved.
 */
export function applyCheck(
  result: CheckResult,
): Effect.Effect<
  { readonly opened: number; readonly resolved: number },
  DatabaseError,
  DatabaseService
> {
  const still = [
    ...result.firing.map((signal) => signal.subjectKey),
    ...result.keep,
  ];
  return withScope(SYSTEM_SCOPE, (tx) =>
    Effect.gen(function* () {
      const opened =
        result.firing.length === 0
          ? []
          : yield* query(() =>
              tx
                .insert(opsAlerts)
                .values(
                  result.firing.map((signal) => ({
                    kind: signal.kind,
                    subjectKey: signal.subjectKey,
                    organizationId: signal.organizationId,
                    title: signal.title,
                    details: signal.details,
                  })),
                )
                .onConflictDoNothing()
                .returning({ id: opsAlerts.id }),
            );
      const resolved = yield* query(() =>
        tx
          .update(opsAlerts)
          .set({ resolvedAt: sql`now()` })
          .where(
            and(
              eq(opsAlerts.kind, result.kind),
              isNull(opsAlerts.resolvedAt),
              still.length === 0
                ? undefined
                : notInArray(opsAlerts.subjectKey, still),
            ),
          )
          .returning({ id: opsAlerts.id }),
      );
      return { opened: opened.length, resolved: resolved.length };
    }),
  );
}

/**
 * Records an alert where it happens, e.g. a webhook with a bad signature:
 * opens an incident, or counts one more occurrence of the open one.
 */
export function raiseAlert(
  signal: AlertSignal,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .insert(opsAlerts)
        .values({
          kind: signal.kind,
          subjectKey: signal.subjectKey,
          organizationId: signal.organizationId,
          title: signal.title,
          details: signal.details,
        })
        .onConflictDoUpdate({
          target: [opsAlerts.kind, opsAlerts.subjectKey],
          targetWhere: sql`${opsAlerts.resolvedAt} IS NULL`,
          set: {
            lastSeenAt: sql`now()`,
            occurrences: sql`${opsAlerts.occurrences} + 1`,
          },
        }),
    ),
  );
}

/** Marks a station job's run as finished, on the database's clock. */
export function recordHeartbeat(
  job: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .insert(stationHeartbeats)
        .values({ job, lastFinishedAt: sql`now()` })
        .onConflictDoUpdate({
          target: stationHeartbeats.job,
          set: { lastFinishedAt: sql`now()` },
        }),
    ),
  );
}

/** How long a claimed email is left to its sender before another may retry it. */
const SEND_CLAIM_MS = 5 * 60_000;
const MAX_RETRY_WAIT_MS = 60 * 60_000;
const SENDS_PER_RUN = 20;

/** 1, 2, 4 … minutes after each failed try, at most an hour. */
export function retryWaitMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_WAIT_MS);
}

const emailSchema = z.email();

/** `ALERT_EMAILS`, comma-separated; anything that isn't an address is skipped. */
export const alertRecipients: Effect.Effect<readonly string[]> = Effect.gen(
  function* () {
    const raw = yield* Config.withDefault(Config.string("ALERT_EMAILS"), "");
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => {
        if (entry.length === 0) return false;
        if (emailSchema.safeParse(entry).success) return true;
        console.warn("[alerts] ALERT_EMAILS has an invalid address; skipped");
        return false;
      });
  },
).pipe(Effect.orElseSucceed((): readonly string[] => []));

/** Takes an incident's email for this sender, if nobody else has it. */
function claimEmail(
  id: string,
): Effect.Effect<OpsAlertRow | null, DatabaseError, DatabaseService> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .update(opsAlerts)
        .set({
          nextNotifyAt: sql`now() + make_interval(secs => ${SEND_CLAIM_MS / 1000})`,
          notifyAttempts: sql`${opsAlerts.notifyAttempts} + 1`,
        })
        .where(
          and(
            eq(opsAlerts.id, id),
            isNull(opsAlerts.notifiedAt),
            isNull(opsAlerts.resolvedAt),
            lte(opsAlerts.nextNotifyAt, sql`now()`),
          ),
        )
        .returning(),
    ),
  ).pipe(Effect.map(([row]) => row ?? null));
}

function markSent(
  id: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .update(opsAlerts)
        .set({ notifiedAt: sql`now()`, lastNotifyError: null })
        .where(eq(opsAlerts.id, id)),
    ),
  );
}

function markUnsent(
  alert: OpsAlertRow,
  error: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx
        .update(opsAlerts)
        .set({
          nextNotifyAt: sql`now() + make_interval(secs => ${retryWaitMs(alert.notifyAttempts) / 1000})`,
          lastNotifyError: error,
        })
        .where(eq(opsAlerts.id, alert.id)),
    ),
  );
}

export interface NotifySummary {
  /** Emailed, or logged when there's no alert list. */
  readonly notified: number;
  readonly failed: number;
}

/**
 * Emails each open incident not emailed yet, oldest first. An incident
 * that resolved before its email went out isn't sent.
 */
export function notifyOpenAlerts(): Effect.Effect<
  NotifySummary,
  DatabaseError,
  DatabaseService | EmailSender
> {
  return Effect.gen(function* () {
    const pending = yield* withScope(SYSTEM_SCOPE, (tx) =>
      query(() =>
        tx
          .select({ id: opsAlerts.id })
          .from(opsAlerts)
          .where(
            and(
              isNull(opsAlerts.notifiedAt),
              isNull(opsAlerts.resolvedAt),
              lte(opsAlerts.nextNotifyAt, sql`now()`),
            ),
          )
          .orderBy(asc(opsAlerts.openedAt), asc(opsAlerts.id))
          .limit(SENDS_PER_RUN),
      ),
    );
    if (pending.length === 0) return { notified: 0, failed: 0 };

    const sender = yield* EmailSender;
    const recipients = yield* alertRecipients;
    let notified = 0;
    let failed = 0;
    for (const { id } of pending) {
      const alert = yield* claimEmail(id);
      if (!alert) continue;
      if (recipients.length === 0) {
        console.warn(
          `[alerts] ${alert.title} (ALERT_EMAILS isn't set, so it's only logged)`,
          alert.details.map(({ label, value }) => `${label}: ${value}`),
        );
        yield* markSent(alert.id);
        notified += 1;
        continue;
      }
      const delivered = yield* Effect.forEach(
        recipients,
        (to) =>
          sender.send(
            opsAlertEmail({
              to,
              alertId: alert.id,
              title: alert.title,
              details: alert.details,
              openedAt: alert.openedAt,
            }),
          ),
        { discard: true },
      ).pipe(Effect.either);
      if (delivered._tag === "Right") {
        yield* markSent(alert.id);
        notified += 1;
      } else {
        console.error(
          `[alerts] alert ${alert.id} not emailed: ${delivered.left.message}`,
        );
        yield* markUnsent(alert, delivered.left.message);
        failed += 1;
      }
    }
    return { notified, failed };
  });
}
