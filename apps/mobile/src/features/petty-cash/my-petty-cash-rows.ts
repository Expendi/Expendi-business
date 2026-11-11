import type { FloatDetail, FloatMovement } from "@expendi-business/shared";

import type { ClaimStatusTone } from "../claims/claim-status-labels";
import { CLAIM_STATUSES, claimStatusLabel } from "../claims/claim-status-labels";
import { formatShortDate, localIsoDate } from "../claims/dates";
import { formatKesCents } from "../../lib/money";
import { kes, MOVEMENT_LABELS, PHASE_LABELS } from "./float-display";

export interface FloatRowData {
  key: string;
  title: string;
  meta: string;
  metaTone: "default" | "negative" | "positive";
  amount: string;
}

export interface SpendingRowData extends FloatRowData {
  /** The reimbursement for what went over the float, when the row opens it. */
  claimId: string | null;
}

const LONE_CLAIM_TONES: Record<ClaimStatusTone, FloatRowData["metaTone"]> = {
  neutral: "default",
  success: "positive",
  attention: "negative",
  problem: "negative",
};

/** Spending against the float, latest first, then reimbursements with no spending line. */
export function spendingRows(float: FloatDetail, today: string): SpendingRowData[] {
  const lone = float.overspendClaims.filter(
    (claim) =>
      !float.spending.some((entry) => entry.overspendClaim?.id === claim.id),
  );
  return [
    ...float.spending.map((entry): SpendingRowData => {
      const parts = [
        formatShortDate(entry.spentOn, today),
        entry.category.name,
        ...(entry.overspendClaim
          ? [`${kes(entry.overspendClaim.amountKes)} over, sent as a reimbursement`]
          : []),
      ];
      return {
        key: entry.id,
        title: entry.merchant,
        meta: entry.noReceipt
          ? ["No receipt", ...parts].join(" · ")
          : parts.join(" · "),
        metaTone: entry.noReceipt ? "negative" : "default",
        amount: formatKesCents(entry.amountKes),
        claimId: entry.overspendClaim?.id ?? null,
      };
    }),
    ...lone.map(
      (claim): SpendingRowData => ({
        key: claim.id,
        title: claim.merchant,
        meta: `${formatShortDate(claim.spentOn, today)} · Sent as a reimbursement, nothing was left · ${claimStatusLabel(claim.status)}`,
        metaTone: LONE_CLAIM_TONES[CLAIM_STATUSES[claim.status].tone],
        amount: formatKesCents(claim.amountKes),
        claimId: claim.id,
      }),
    ),
  ];
}

/** Money in and out of the float; movements still waiting for approval are left out. */
export function movementRows(
  movements: readonly FloatMovement[],
  today: string,
): FloatRowData[] {
  return movements
    .filter((movement) => movement.phase !== "awaiting_approval")
    .map((movement) => {
      const date = formatShortDate(
        localIsoDate(new Date(movement.createdAt)),
        today,
      );
      return {
        key: movement.id,
        title: MOVEMENT_LABELS[movement.type],
        meta: [PHASE_LABELS[movement.phase], date, movement.note]
          .filter((part) => part !== null)
          .join(" · "),
        metaTone:
          movement.phase === "paid"
            ? "positive"
            : movement.phase === "failed"
              ? "negative"
              : "default",
        amount: formatKesCents(movement.amountKes),
      };
    });
}
