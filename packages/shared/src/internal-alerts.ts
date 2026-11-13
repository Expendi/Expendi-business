import { z } from "zod";

/**
 * Alerts to the Expendi team and the admin app's system health (spec
 * §6.16, T26). Both are read-only: an alert opens and resolves on its own,
 * and staff never change one.
 */

export const OPS_ALERT_KINDS = [
  "payout_needs_review",
  "payout_failed",
  "webhook_signature_failure",
  "reconciliation_stopped",
  "low_company_balance",
  "zoho_sync_failing",
  "card_close_failed",
  "unexpected_transit_transfer",
  "deposits_held",
  "treasury_move_stuck",
  "treasury_usdc_idle",
  "treasury_position_mismatch",
  "treasury_partial_fill",
  "confidential_balance_mismatch",
] as const;
export const opsAlertKindSchema = z.enum(OPS_ALERT_KINDS);
export type OpsAlertKind = z.infer<typeof opsAlertKindSchema>;

/**
 * - `sent`: emailed to the alert list, or only logged when the API has no
 *   alert list
 * - `pending`: not tried yet
 * - `retrying`: a send failed and is tried again at `nextAttemptAt`
 * - `not_sent`: the alert resolved before its email went out
 */
export const OPS_ALERT_EMAIL_STATUSES = [
  "sent",
  "pending",
  "retrying",
  "not_sent",
] as const;
export const opsAlertEmailStatusSchema = z.enum(OPS_ALERT_EMAIL_STATUSES);
export type OpsAlertEmailStatus = z.infer<typeof opsAlertEmailStatusSchema>;

export const opsAlertSchema = z.object({
  id: z.uuid(),
  kind: opsAlertKindSchema,
  /** What it's about: a payout ID, a company ID, a webhook source or a job. */
  subjectKey: z.string(),
  organization: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  title: z.string(),
  /** The email's lines, e.g. `Company: Acme Ltd`. */
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  /** How often the cause was seen while open, e.g. failed webhook signatures. */
  occurrences: z.number().int().positive(),
  openedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  email: z.object({
    status: opsAlertEmailStatusSchema,
    sentAt: z.iso.datetime().nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
  }),
});

export type OpsAlert = z.infer<typeof opsAlertSchema>;

/** `GET /internal/alerts`: every open alert, then those resolved since `resolvedSince`. */
export const opsAlertsResponseSchema = z.object({
  open: z.array(opsAlertSchema),
  /** Newest first. */
  recentlyResolved: z.array(opsAlertSchema),
  resolvedSince: z.iso.datetime(),
  /** More alerts than one response holds; the oldest resolved are left out. */
  truncated: z.boolean(),
});

export type OpsAlertsResponse = z.infer<typeof opsAlertsResponseSchema>;

/** A cash-out provider's reconciliation job, judged by its heartbeat. */
const reconciliationHealthSchema = z.object({
  job: z.string(),
  /** Null if the job has never finished a run. */
  lastFinishedAt: z.iso.datetime().nullable(),
  /** No finished run in this long fires "Reconciliation stopped". */
  staleAfterMinutes: z.number().int().positive(),
  stale: z.boolean(),
});

/** A provider webhook's latest signature-failure incident. */
const webhookHealthSchema = z.object({
  /** An open incident resolves once this long passes with no new failure. */
  resolvesAfterQuietMinutes: z.number().int().positive(),
  /** The open incident, or else the last one; null if none ever opened. */
  signatureFailures: z
    .object({
      alertId: z.uuid(),
      open: z.boolean(),
      /** Failed signatures counted while the incident was open. */
      count: z.number().int().positive(),
      firstSeenAt: z.iso.datetime(),
      lastSeenAt: z.iso.datetime(),
      resolvedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});

/**
 * `GET /internal/health`: the station jobs, and each cash-out provider's
 * reconciliation and webhook. `reconciliation` is Paycrest's.
 */
export const systemHealthSchema = z.object({
  /** The database's clock when this was read. */
  checkedAt: z.iso.datetime(),
  reconciliation: reconciliationHealthSchema,
  pretiumReconciliation: reconciliationHealthSchema,
  paycrestWebhook: webhookHealthSchema,
  pretiumWebhook: webhookHealthSchema,
  /** Every station job that records a heartbeat, by name. */
  jobs: z.array(
    z.object({ job: z.string(), lastFinishedAt: z.iso.datetime() }),
  ),
});

export type SystemHealth = z.infer<typeof systemHealthSchema>;
