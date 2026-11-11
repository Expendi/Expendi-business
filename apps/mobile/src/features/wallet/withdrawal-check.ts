import type { Withdrawal } from "@expendi-business/shared";

type Reviewed = Pick<Withdrawal, "chain" | "address" | "amountUsdc">;

/**
 * Whether the withdrawal the API prepared is the one the admin reviewed, so
 * only that is signed. Addresses are compared as written: a NEAR account or
 * a Solana address has no other case.
 */
export function isReviewedWithdrawal(
  prepared: Reviewed,
  reviewed: Reviewed,
): boolean {
  return (
    prepared.amountUsdc === reviewed.amountUsdc &&
    prepared.chain === reviewed.chain &&
    prepared.address === reviewed.address
  );
}
