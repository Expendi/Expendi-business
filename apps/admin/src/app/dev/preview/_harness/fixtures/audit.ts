import type { AuditEntry } from "@expendi-business/shared";

import { COMPANY_ID } from "./companies";
import { minutesAgo, sampleId } from "./ids";
import { PAYOUT_ID } from "./payouts";

const MWANGAZA = { id: COMPANY_ID, name: "Mwangaza Logistics" };

export const AUDIT_ENTRIES: AuditEntry[] = [
  {
    id: sampleId(801),
    occurredAt: minutesAgo(12),
    actor: { type: "system", id: "paycrest-webhook", email: null },
    organization: null,
    action: "webhook.signature_failed",
    entity: { type: "webhook", id: "paycrest" },
    before: null,
    after: { reason: "Signature didn't match" },
    requestId: "req_c19a02",
    ip: "34.201.18.6",
    userAgent: null,
  },
  {
    id: sampleId(802),
    occurredAt: minutesAgo(42),
    actor: { type: "system", id: "payout-reconciliation", email: null },
    organization: MWANGAZA,
    action: "payout.needs_review",
    entity: { type: "payout", id: PAYOUT_ID },
    before: { status: "paying" },
    after: { status: "needs_review" },
    requestId: null,
    ip: null,
    userAgent: null,
  },
  {
    id: sampleId(803),
    occurredAt: minutesAgo(95),
    actor: {
      type: "staff",
      id: sampleId(901),
      email: "amina.hassan@expendi.app",
    },
    organization: MWANGAZA,
    action: "zoho.mapping_saved",
    entity: { type: "accounting_connection", id: sampleId(950) },
    before: { defaultAccountId: "4600000000000351" },
    after: { defaultAccountId: "4600000000000367" },
    requestId: "req_71be55",
    ip: "197.232.14.20",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  },
  {
    id: sampleId(804),
    occurredAt: minutesAgo(140),
    actor: {
      type: "user",
      id: sampleId(101),
      email: "wanjiru@mwangaza.co.ke",
    },
    organization: MWANGAZA,
    action: "bill.approved",
    entity: { type: "bill", id: sampleId(301) },
    before: { status: "awaiting_approval" },
    after: { status: "approved" },
    requestId: "req_0d4f9a",
    ip: "105.163.2.41",
    userAgent: "Expendi/1.4.0 (Android 15)",
  },
  {
    id: sampleId(805),
    occurredAt: minutesAgo(400),
    actor: {
      type: "staff",
      id: sampleId(902),
      email: "peter.otieno@expendi.app",
    },
    organization: null,
    action: "staff.session_started",
    entity: { type: "staff_user", id: sampleId(902) },
    before: null,
    after: null,
    requestId: "req_aa81f0",
    ip: "197.232.14.31",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  },
  {
    id: sampleId(806),
    occurredAt: minutesAgo(1500),
    actor: {
      type: "staff",
      id: sampleId(901),
      email: "amina.hassan@expendi.app",
    },
    organization: { id: sampleId(4), name: "Pwani Coastal Tours" },
    action: "payouts.paused",
    entity: { type: "organization", id: sampleId(4) },
    before: { payoutsPaused: false },
    after: { payoutsPaused: true, reason: "Bank details under review" },
    requestId: "req_5c20d7",
    ip: "197.232.14.20",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  },
];
