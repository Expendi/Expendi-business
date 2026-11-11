import type {
  Claim,
  ClaimDetail,
  EtimsStatus,
  ExpenseWarning,
} from "@expendi-business/shared";

import { formatKesCents } from "../../lib/money";
import {
  dayCount,
  daysBetween,
  formatDayMonth,
  formatShortDate,
  localIsoDate,
} from "../claims/dates";

/** What the Review screen and the approvals queue say, kept apart from the views. */

export type AfterPaying =
  | { readonly kind: "available"; readonly kes: string }
  | { readonly kind: "short"; readonly kes: string };

/**
 * What the company has left once this reimbursement is paid. Null when the
 * overview couldn't work out what's available (no KES rate).
 */
export function afterPaying(
  availableKes: string | null,
  amountKes: string,
): AfterPaying | null {
  if (availableKes === null) return null;
  const left = BigInt(availableKes) - BigInt(amountKes);
  return left < 0n
    ? { kind: "short", kes: formatKesCents((-left).toString()) }
    : { kind: "available", kes: formatKesCents(left.toString()) };
}

/** The callout's sentence, split so the amount can be set in bold. */
export function afterPayingParts(
  outcome: AfterPaying,
  through: string,
): { readonly before: string; readonly amount: string; readonly after: string } {
  const day = formatDayMonth(through);
  return outcome.kind === "available"
    ? {
        before: "After paying, ",
        amount: `KES ${outcome.kes}`,
        after: ` is available to ${day}.`,
      }
    : {
        before: "Paying this leaves the company ",
        amount: `KES ${outcome.kes}`,
        after: ` short for what's due to ${day}.`,
      };
}

export interface QueuePosition {
  readonly position: number;
  readonly total: number;
}

/** Where a reimbursement sits in the loaded queue; null when it isn't in it. */
export function queuePosition(
  queueIds: readonly string[],
  claimId: string,
): QueuePosition | null {
  const index = queueIds.indexOf(claimId);
  return index === -1 ? null : { position: index + 1, total: queueIds.length };
}

export function queuePositionLabel({ position, total }: QueuePosition): string {
  return `${String(position)} of ${String(total)}`;
}

function daysAgo(createdAt: string, today: string): number | null {
  return daysBetween(localIsoDate(new Date(createdAt)), today);
}

/** "Submitted Mon 9 Nov · 2 days ago". */
export function submittedLine(createdAt: string, today: string): string {
  const day = formatShortDate(localIsoDate(new Date(createdAt)), today);
  const days = daysAgo(createdAt, today);
  if (days === null) return `Submitted ${day}`;
  if (days <= 0) return `Submitted ${day} · today`;
  return `Submitted ${day} · ${dayCount(days)} ago`;
}

/** How long a queue row has waited: "Waiting 2 days", or "Submitted today". */
export function waitingLabel(createdAt: string, today: string): string {
  const days = daysAgo(createdAt, today);
  return days === null || days <= 0
    ? "Submitted today"
    : `Waiting ${dayCount(days)}`;
}

const WARNING_LABELS: Record<ExpenseWarning["code"], string> = {
  near_duplicate: "Possible duplicate",
  older_than_60_days: "Over 60 days old",
};

export interface QueueRowView {
  readonly title: string;
  readonly meta: string;
  readonly metaTone: "default" | "negative";
  readonly amount: string;
  readonly flags: readonly string[];
}

/** One queue row: who, what and how long, with anything to check first. */
export function queueRowView(
  claim: Claim,
  today: string,
  failed: boolean,
): QueueRowView {
  const flags = [
    ...(failed ? ["Payment failed"] : []),
    ...(!failed && !claim.submittedBy.payoutPhoneConfirmed
      ? ["No payout number yet"]
      : []),
    ...[...new Set(claim.warnings.map((warning) => warning.code))].map(
      (code) => WARNING_LABELS[code],
    ),
  ];
  const detail = `${claim.merchant} · ${waitingLabel(claim.createdAt, today)}`;
  return {
    title: claim.submittedBy.name ?? claim.submittedBy.email,
    meta: flags.length === 0 ? detail : `${flags.join(", ")}\n${detail}`,
    metaTone: flags.length === 0 ? "default" : "negative",
    amount: formatKesCents(claim.amountKes),
    flags,
  };
}

const ETIMS_LABELS: Record<EtimsStatus, string> = {
  attached: "Invoice attached",
  not_required: "Not needed for this category",
  none: "No invoice",
};

export interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly stacked?: boolean;
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** The Details group: what the amount was for and where the money goes. */
export function detailRows(claim: ClaimDetail, isAdmin: boolean): DetailRow[] {
  const person = claim.submittedBy.name ?? claim.submittedBy.email;
  return [
    { label: "Category", value: claim.category.name },
    ...(isAdmin
      ? [
          {
            label: "Pay to",
            value: claim.submittedBy.payoutPhoneConfirmed
              ? "M-Pesa, number confirmed"
              : "No M-Pesa number yet",
          },
        ]
      : []),
    ...(claim.description
      ? [
          {
            label: isAdmin ? `Note from ${firstName(person)}` : "What it was for",
            value: claim.description,
            stacked: true,
          },
        ]
      : []),
    ...(claim.mpesaCode
      ? [{ label: "M-Pesa code", value: claim.mpesaCode }]
      : []),
    ...(claim.etimsStatus === "attached"
      ? []
      : [{ label: "eTIMS", value: ETIMS_LABELS[claim.etimsStatus] }]),
  ];
}

export interface EtimsEvidence {
  readonly title: string;
  readonly meta: string;
}

/** The eTIMS invoice as evidence, when the reimbursement has one. */
export function etimsEvidence(claim: ClaimDetail): EtimsEvidence | null {
  if (claim.etimsStatus !== "attached") return null;
  const parts = [
    claim.etimsInvoiceNumber,
    claim.etimsSupplierPin ? `Supplier PIN ${claim.etimsSupplierPin}` : null,
    claim.etimsQrPayload ? "QR code scanned" : null,
  ].filter((part): part is string => part !== null);
  return {
    title: "eTIMS invoice",
    meta: parts.length === 0 ? "Invoice attached" : parts.join(" · "),
  };
}
