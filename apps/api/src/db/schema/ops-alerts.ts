import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { OPS_ALERT_KINDS } from "@expendi-business/shared";

import { organizations } from "./organizations.js";

/** The six alerts to the Expendi team (spec §6.16). */
export const opsAlertKind = pgEnum("ops_alert_kind", OPS_ALERT_KINDS);
export type { OpsAlertKind } from "@expendi-business/shared";

/** One line of an alert's email, e.g. `Company: Acme Ltd`. */
export interface OpsAlertDetail {
  readonly label: string;
  readonly value: string;
}

/**
 * One incident of an alert (spec §6.16): open while its cause holds, then
 * resolved. `subject_key` names what it's about (a payout, a company, a
 * webhook source, a job), and the unique index allows one open incident per
 * kind and subject, so a second check or a second API instance can't open
 * it again. A failed payout alerts once ever: it can't fail twice.
 *
 * Its email goes out once: a sender claims it by pushing `next_notify_at`
 * forward, so another can't take it meanwhile, and `notified_at` marks it
 * sent. `title` and `details` are the email, and never hold a secret, a
 * token or a salary.
 */
export const opsAlerts = pgTable(
  "ops_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: opsAlertKind("kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    title: text("title").notNull(),
    details: jsonb("details").$type<readonly OpsAlertDetail[]>().notNull(),
    /** How often the cause was seen while open, e.g. failed webhook signatures. */
    occurrences: integer("occurrences").notNull().default(1),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    nextNotifyAt: timestamp("next_notify_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastNotifyError: text("last_notify_error"),
  },
  (table) => [
    uniqueIndex("ops_alerts_one_open_per_subject")
      .on(table.kind, table.subjectKey)
      .where(sql`${table.resolvedAt} IS NULL`),
    uniqueIndex("ops_alerts_payout_failed_once")
      .on(table.subjectKey)
      .where(sql`${table.kind} = 'payout_failed'`),
    index("ops_alerts_unsent_idx")
      .on(table.nextNotifyAt)
      .where(sql`${table.notifiedAt} IS NULL AND ${table.resolvedAt} IS NULL`),
    check("ops_alerts_occurrences_positive", sql`${table.occurrences} >= 1`),
    check(
      "ops_alerts_notify_attempts_non_negative",
      sql`${table.notifyAttempts} >= 0`,
    ),
  ],
);

export type OpsAlertRow = typeof opsAlerts.$inferSelect;

/**
 * When each station job last finished a run, for the "reconciliation
 * stopped" alert (spec §6.16) and the admin app's system health.
 */
export const stationHeartbeats = pgTable("station_heartbeats", {
  job: text("job").primaryKey(),
  lastFinishedAt: timestamp("last_finished_at", {
    withTimezone: true,
  }).notNull(),
});
