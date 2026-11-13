import type { ClientError } from "../errors.js";
import type { PayoutRejected } from "../services/payout/payout-errors.js";
import { BadRequest, Conflict, Forbidden } from "../errors.js";

/**
 * A payment the engine refused, as the client error the app shows. The
 * engine's messages are written for the admin, so they pass through.
 */
export function payoutRejectionAsClientError(
  error: PayoutRejected,
): ClientError {
  const { message, details } = error;
  switch (error.reason) {
    case "not_an_admin":
    case "approval_mismatch":
    case "not_allowlisted":
      return new Forbidden({ message });
    case "insufficient_balance":
      return new Conflict({ message, ...(details && { details }) });
    case "subject_already_paying":
    case "idempotency_key_reused":
    case "not_awaiting_approval":
    case "daily_cap":
    case "payroll_cap":
    case "paused":
    case "no_wallet":
    case "subject_not_payable":
    case "cash_out_unavailable":
      return new Conflict({ message });
    case "empty_batch":
    case "mixed_batch":
    case "invalid_recipient":
    case "invalid_amount":
    case "over_transaction_cap":
      return new BadRequest({ message });
  }
}
