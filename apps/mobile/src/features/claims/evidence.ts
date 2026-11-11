/** Which way of adding proof a new reimbursement opens with (`?evidence=`). */
export const CLAIM_EVIDENCE = ["receipt", "sms", "etims"] as const;
export type ClaimEvidence = (typeof CLAIM_EVIDENCE)[number];

/** Reads the route param; anything unknown opens the plain form. */
export function parseEvidence(
  value: string | string[] | undefined,
): ClaimEvidence | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return CLAIM_EVIDENCE.find((evidence) => evidence === first);
}
