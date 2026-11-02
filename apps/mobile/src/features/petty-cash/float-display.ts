import type {
  FloatApproval,
  FloatMovement,
  FloatMovementPhase,
  FloatMovementType,
  FloatPaymentPreview,
  FloatPaymentResult,
  FloatSummary,
  Member,
} from "@expendi-business/shared";
import { parseKesToCents, splitFloatPurchase } from "@expendi-business/shared";

import type { PreviewRow } from "../claims/payment";
import { ApiError } from "../../lib/api";
import { formatKesCents, formatUsdc } from "../../lib/money";

/**
 * Petty cash display logic (spec §6.22): the balance as people read it,
 * what each movement was, the overspend notice before a purchase is
 * recorded, and the cost of an issue or top-up before the admin's passkey.
 */

export const kes = (cents: string): string => `KES ${formatKesCents(cents)}`;

export const MOVEMENT_LABELS: Record<FloatMovementType, string> = {
  issue: "Issued",
  top_up: "Top-up",
  return: "Handed back",
  write_off: "Written off at closing",
};

export const PHASE_LABELS: Record<FloatMovementPhase, string> = {
  awaiting_approval: "Waiting for approval",
  on_its_way: "On its way",
  paid: "Paid",
  failed: "Failed",
  recorded: "Recorded",
};

export function holderName(float: Pick<FloatSummary, "holder">): string {
  return float.holder.name ?? float.holder.email;
}

/** The balance's parts; on-the-way and waiting payments show only when there are any. */
export function balanceRows(float: FloatSummary): PreviewRow[] {
  return [
    { label: "Issued", value: kes(float.issuedKes) },
    { label: "Spent", value: kes(float.spentKes) },
    ...(float.returnedKes === "0"
      ? []
      : [{ label: "Handed back", value: kes(float.returnedKes) }]),
    ...(float.writtenOffKes === "0"
      ? []
      : [{ label: "Written off", value: kes(float.writtenOffKes) }]),
    ...(float.onTheWayKes === "0"
      ? []
      : [{ label: "On its way", value: kes(float.onTheWayKes) }]),
    ...(float.awaitingApprovalKes === "0"
      ? []
      : [
          {
            label: "Waiting for approval",
            value: kes(float.awaitingApprovalKes),
          },
        ]),
  ];
}

/**
 * "KES X will be submitted as a claim" when the typed amount is more than
 * what's left; null while it fits or the amount isn't readable yet.
 */
export function overspendNotice(
  typedAmount: string,
  leftKes: string,
): string | null {
  const amount = parseKesToCents(typedAmount);
  if (amount === null || amount <= 0n) return null;
  const { fromFloatKes, claimedKes } = splitFloatPurchase(
    amount,
    BigInt(leftKes),
  );
  if (claimedKes === 0n) return null;
  const claimed = kes(claimedKes.toString());
  return fromFloatKes === 0n
    ? `Nothing is left on your float, so ${claimed} will be submitted as a claim for an admin to approve.`
    : `${kes(fromFloatKes.toString())} comes from your float and ${claimed} will be submitted as a claim for an admin to approve.`;
}

/** Who can hold a float: active admins and employees with a confirmed M-Pesa number. */
export function canHoldFloat(member: Member): boolean {
  return (
    member.status === "active" &&
    member.role !== "accountant" &&
    member.payoutPhoneConfirmed
  );
}

/** The float a refused issue points to, when the person already holds one. */
export function existingFloatId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const { details } = error;
  if (typeof details !== "object" || details === null) return null;
  const floatId: unknown = "floatId" in details ? details.floatId : null;
  return typeof floatId === "string" ? floatId : null;
}

/** An issue or top-up's payment, as the admin confirms it. */
export function paymentRows(payment: FloatPaymentPreview): PreviewRow[] {
  const rounded = payment.requestedKes !== payment.receivesKes;
  return [
    { label: "They receive", value: kes(payment.receivesKes) },
    ...(rounded
      ? [
          {
            label: "Asked for",
            value: `${kes(payment.requestedKes)}, rounded up to a whole shilling for M-Pesa`,
          },
        ]
      : []),
    {
      label: "Paid to",
      value: `${payment.holderName}, M-Pesa ending ${payment.phoneLast4}`,
    },
    { label: "USDC", value: `${formatUsdc(payment.usdc)} USDC` },
    {
      label: "Paycrest fee, at most",
      value: `${formatUsdc(payment.feeAllowanceUsdc)} USDC`,
    },
    {
      label: "Total, at most",
      value: `${formatUsdc(payment.maxDebitUsdc)} USDC`,
    },
  ];
}

/** Whether a fresh preparation still costs what the admin reviewed. */
export function sameFloatCost(
  reviewed: FloatApproval,
  fresh: FloatApproval,
): boolean {
  return (
    reviewed.payment.payoutId === fresh.payment.payoutId &&
    reviewed.payment.maxDebitUsdc === fresh.payment.maxDebitUsdc &&
    reviewed.payment.receivesKes === fresh.payment.receivesKes
  );
}

/** An issue or top-up the admin can act on: approve it, or retry it. */
export function movementAction(
  movement: FloatMovement,
): "approve" | "retry" | null {
  if (movement.phase === "awaiting_approval") return "approve";
  if (movement.phase === "failed") return "retry";
  return null;
}

export type FloatPaymentOutcome = "sent" | "paid" | "failed" | "review";

export function floatPaymentOutcome(
  result: FloatPaymentResult,
): FloatPaymentOutcome {
  const { movement } = result;
  if (movement.payout?.status === "needs_review") return "review";
  if (movement.status === "failed") return "failed";
  if (movement.status === "paid") return "paid";
  return "sent";
}

export const PAYMENT_OUTCOMES: Record<
  FloatPaymentOutcome,
  { readonly title: string; readonly body: string }
> = {
  review: {
    title: "Expendi is checking this payment",
    body: "Its outcome isn’t clear yet. Don’t pay it again: Expendi will settle it.",
  },
  failed: {
    title: "The payment failed",
    body: "No money reached M-Pesa, and the USDC stays in or returns to the wallet. You can retry it.",
  },
  paid: {
    title: "Paid",
    body: "The money reached their M-Pesa and is on the float.",
  },
  sent: {
    title: "Payment sent",
    body: "It usually reaches M-Pesa within a minute or two. It counts toward the float once it arrives.",
  },
};
