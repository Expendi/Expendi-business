import type { Claim, ExpenseStatus } from "@expendi-business/shared";

import { formatKesCents } from "../../lib/money";
import { dayCount, daysBetween, formatShortDate } from "./dates";

/** Money the company still owes the person: waiting for approval, or approved and on its way. */
export const OWED_STATUSES = [
  "submitted",
  "paying",
  "payout_failed",
] as const satisfies readonly ExpenseStatus[];

/** Handed back to the person to fix and resubmit. */
export const RETURNED_STATUSES = [
  "rejected",
] as const satisfies readonly ExpenseStatus[];

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

type Owed = Pick<Claim, "status" | "amountKes">;

/** KES cents the company owes across `claims`, whatever else the list holds. */
export function owedTotalCents(claims: readonly Owed[]): string {
  return claims
    .filter((claim) =>
      (OWED_STATUSES as readonly ExpenseStatus[]).includes(claim.status),
    )
    .reduce((sum, claim) => sum + BigInt(claim.amountKes), 0n)
    .toString();
}

/** A payment's instant as the Nairobi calendar day, `YYYY-MM-DD`. */
export function nairobiDay(isoInstant: string): string {
  return new Date(Date.parse(isoInstant) + NAIROBI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export interface LatestPayment {
  amountKes: string;
  /** `YYYY-MM-DD`, Nairobi time. */
  day: string;
}

interface PaidSalary {
  status: string;
  amountKes: string;
  paidOn: string | null;
}

/**
 * The newest money paid to the person: a paid reimbursement or a paid salary,
 * whichever is later. A tie goes to the reimbursement, which has the exact time.
 */
export function latestPayment(
  claims: readonly Pick<Claim, "status" | "amountKes" | "paidAt">[],
  salary: readonly PaidSalary[],
): LatestPayment | null {
  let best: LatestPayment | null = null;
  let bestInstant = Number.NEGATIVE_INFINITY;
  for (const claim of claims) {
    if (claim.status !== "paid" || claim.paidAt === null) continue;
    const instant = Date.parse(claim.paidAt);
    if (instant > bestInstant) {
      bestInstant = instant;
      best = { amountKes: claim.amountKes, day: nairobiDay(claim.paidAt) };
    }
  }
  for (const payment of salary) {
    if (payment.status !== "paid" || payment.paidOn === null) continue;
    if (best === null || payment.paidOn > best.day) {
      best = { amountKes: payment.amountKes, day: payment.paidOn };
    }
  }
  return best;
}

export type ReimbursementIcon = "waiting" | "returned" | "paid";

export interface ReimbursementLine {
  title: string;
  meta: string;
  metaTone: "default" | "negative" | "positive";
  /** KES cents formatted for display, e.g. "6,170.00". */
  amount: string;
  amountTone: "default" | "muted";
  icon: ReimbursementIcon;
}

type Line = Pick<
  Claim,
  | "status"
  | "merchant"
  | "amountKes"
  | "rejectedReason"
  | "createdAt"
  | "paidAt"
>;

/** A reimbursement as the person reads it: status in words, dates in human form. */
export function reimbursementLine(claim: Line, today: string): ReimbursementLine {
  const base = {
    title: claim.merchant,
    amount: formatKesCents(claim.amountKes),
  };
  switch (claim.status) {
    case "submitted": {
      const days = daysBetween(nairobiDay(claim.createdAt), today);
      return {
        ...base,
        meta:
          days === null || days <= 0
            ? "Waiting for approval"
            : `Waiting for approval · ${dayCount(days)}`,
        metaTone: "default",
        amountTone: "default",
        icon: "waiting",
      };
    }
    case "rejected":
      return {
        ...base,
        meta: claim.rejectedReason
          ? `Returned · ${claim.rejectedReason}`
          : "Returned",
        metaTone: "negative",
        amountTone: "default",
        icon: "returned",
      };
    case "paying":
      return {
        ...base,
        meta: "Being paid to M-Pesa",
        metaTone: "default",
        amountTone: "default",
        icon: "waiting",
      };
    case "payout_failed":
      return {
        ...base,
        meta: "Payment didn’t go through",
        metaTone: "negative",
        amountTone: "default",
        icon: "returned",
      };
    case "paid":
      return {
        ...base,
        meta:
          claim.paidAt === null
            ? "Paid"
            : `Paid · ${formatShortDate(nairobiDay(claim.paidAt), today)}`,
        metaTone: "positive",
        amountTone: "muted",
        icon: "paid",
      };
    case "paid_outside":
      return {
        ...base,
        meta: "Paid before Expendi",
        metaTone: "default",
        amountTone: "muted",
        icon: "paid",
      };
    case "recorded":
      return {
        ...base,
        meta: "Recorded",
        metaTone: "default",
        amountTone: "muted",
        icon: "paid",
      };
  }
}
