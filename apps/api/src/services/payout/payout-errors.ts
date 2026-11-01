import { Data } from "effect";

export type PayoutRejectionReason =
  | "empty_batch"
  | "mixed_batch"
  | "no_wallet"
  | "invalid_recipient"
  | "subject_already_paying"
  | "idempotency_key_reused"
  | "not_an_admin"
  | "not_awaiting_approval"
  | "approval_mismatch"
  | "paused"
  | "insufficient_balance"
  | "daily_cap"
  | "payroll_cap"
  | "not_allowlisted"
  | "over_transaction_cap"
  | "invalid_amount";

/**
 * A payment the engine refused before any order was created or any money
 * moved. `message` is safe to show the admin.
 */
export class PayoutRejected extends Data.TaggedError("PayoutRejected")<{
  readonly reason: PayoutRejectionReason;
  readonly message: string;
}> {}
