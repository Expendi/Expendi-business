import type {
  OpsAlert,
  OpsAlertsResponse,
  SystemHealth,
} from "@expendi-business/shared";

import { COMPANY_ID } from "./companies";
import { minutesAgo, NOW, sampleId } from "./ids";
import { PAYOUT_ID } from "./payouts";

const sentEmail = (minutes: number): OpsAlert["email"] => ({
  status: "sent",
  sentAt: minutesAgo(minutes),
  attempts: 1,
  lastError: null,
  nextAttemptAt: null,
});

const OPEN_ALERTS: OpsAlert[] = [
  {
    id: sampleId(701),
    kind: "payout_needs_review",
    subjectKey: PAYOUT_ID,
    organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
    title: "KES 184,500 payout to Rift Valley Fuel Depot needs review",
    details: [
      { label: "Company", value: "Mwangaza Logistics" },
      { label: "Paycrest status", value: "pending" },
    ],
    occurrences: 1,
    openedAt: minutesAgo(42),
    lastSeenAt: minutesAgo(42),
    resolvedAt: null,
    email: sentEmail(41),
  },
  {
    id: sampleId(702),
    kind: "webhook_signature_failure",
    subjectKey: "paycrest",
    organization: null,
    title: "Paycrest webhooks are failing signature checks",
    details: [{ label: "Source", value: "Paycrest" }],
    occurrences: 7,
    openedAt: minutesAgo(180),
    lastSeenAt: minutesAgo(12),
    resolvedAt: null,
    email: {
      status: "retrying",
      sentAt: null,
      attempts: 3,
      lastError: "The mail service didn't answer in time.",
      nextAttemptAt: minutesAgo(-5),
    },
  },
  {
    id: sampleId(703),
    kind: "low_company_balance",
    subjectKey: sampleId(2),
    organization: { id: sampleId(2), name: "Kilimo Fresh Produce Ltd" },
    title: "Kilimo Fresh Produce Ltd can't cover its approved payments",
    details: [
      { label: "Company", value: "Kilimo Fresh Produce Ltd" },
      { label: "Short by", value: "KES 42,300" },
    ],
    occurrences: 2,
    openedAt: minutesAgo(520),
    lastSeenAt: minutesAgo(60),
    resolvedAt: null,
    email: sentEmail(519),
  },
];

const RESOLVED_ALERTS: OpsAlert[] = [
  {
    id: sampleId(704),
    kind: "zoho_sync_failing",
    subjectKey: COMPANY_ID,
    organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
    title: "Syncs to Zoho Books are failing for Mwangaza Logistics",
    details: [{ label: "Failed syncs", value: "3" }],
    occurrences: 3,
    openedAt: minutesAgo(1900),
    lastSeenAt: minutesAgo(1500),
    resolvedAt: minutesAgo(1440),
    email: sentEmail(1899),
  },
  {
    id: sampleId(705),
    kind: "payout_failed",
    subjectKey: sampleId(202),
    organization: { id: sampleId(2), name: "Kilimo Fresh Produce Ltd" },
    title: "KES 12,750 claim payout failed",
    details: [{ label: "Reason", value: "M-Pesa couldn't reach the phone" }],
    occurrences: 1,
    openedAt: minutesAgo(2600),
    lastSeenAt: minutesAgo(2600),
    resolvedAt: minutesAgo(2300),
    email: {
      status: "not_sent",
      sentAt: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    },
  },
];

export const OPS_ALERTS: OpsAlertsResponse = {
  open: OPEN_ALERTS,
  recentlyResolved: RESOLVED_ALERTS,
  resolvedSince: minutesAgo(60 * 24 * 7),
  truncated: false,
};

export const SYSTEM_HEALTH: SystemHealth = {
  checkedAt: NOW,
  reconciliation: {
    job: "payout-reconciliation",
    lastFinishedAt: minutesAgo(3),
    staleAfterMinutes: 15,
    stale: false,
  },
  paycrestWebhook: {
    resolvesAfterQuietMinutes: 30,
    signatureFailures: {
      alertId: sampleId(702),
      open: true,
      count: 7,
      firstSeenAt: minutesAgo(180),
      lastSeenAt: minutesAgo(12),
      resolvedAt: null,
    },
  },
  jobs: [
    { job: "payout-reconciliation", lastFinishedAt: minutesAgo(3) },
    { job: "ops-alerts", lastFinishedAt: minutesAgo(1) },
    { job: "zoho-sync", lastFinishedAt: minutesAgo(6) },
    { job: "deposit-watcher", lastFinishedAt: minutesAgo(2) },
  ],
};
