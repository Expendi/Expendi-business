import type { Payout } from "../../db/schema/index.js";
import { canonicalJson, sha256Hex } from "../approval/passkeys.js";

/**
 * What an admin approves: every payout in the batch (who, what, how much,
 * at most how much USDC) and the totals. The passkey challenge is derived
 * from this hash, so changing any payout, amount, recipient or the set
 * itself after the challenge is issued makes the approval fail.
 */
export function payoutIntentHash(
  organizationId: string,
  batch: readonly Payout[],
): string {
  const items = [...batch]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((payout) => ({
      id: payout.id,
      subjectType: payout.subjectType,
      subjectId: payout.subjectId,
      payrollRunId: payout.payrollRunId,
      method: payout.method,
      recipient: payout.recipient,
      amountKes: payout.amountKes,
      maxDebitUsdc: payout.maxDebitUsdc,
    }));
  return sha256Hex(
    canonicalJson({
      version: 1,
      organizationId,
      payouts: items,
      totals: {
        amountKes: batch.reduce((sum, payout) => sum + payout.amountKes, 0n),
        maxDebitUsdc: batch.reduce(
          (sum, payout) => sum + payout.maxDebitUsdc,
          0n,
        ),
      },
    }),
  );
}
