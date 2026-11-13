import type { BillStatus } from "./bills.js";
import type { ExpenseStatus } from "./claims.js";
import type { FloatMovementPhase } from "./floats.js";
import type { PayrollRunStatus } from "./payroll.js";
import type { PayoutStatus } from "./wallet-history.js";

/** How often a screen asks again while a payment it shows is on its way. */
export const PAYMENT_POLL_MS = 5000;

/** A bill, or a payroll run's payment (each is a bill), being paid. */
export const IN_FLIGHT_BILL_STATUSES = [
  "paying",
] as const satisfies readonly BillStatus[];

export const IN_FLIGHT_CLAIM_STATUSES = [
  "paying",
] as const satisfies readonly ExpenseStatus[];

export const IN_FLIGHT_PAYROLL_RUN_STATUSES = [
  "paying",
] as const satisfies readonly PayrollRunStatus[];

/** A pending issue or top-up still waiting for a passkey isn't on its way. */
export const IN_FLIGHT_FLOAT_MOVEMENT_PHASES = [
  "on_its_way",
] as const satisfies readonly FloatMovementPhase[];

/**
 * Approved and moving. `awaiting_approval` waits for a person, and
 * `needs_review` only Expendi staff can move, so asking again changes
 * nothing.
 */
export const IN_FLIGHT_PAYOUT_STATUSES = [
  "approved",
  "order_created",
  "funding",
  "paying",
] as const satisfies readonly PayoutStatus[];

/**
 * The statuses a screen shows, by kind; leave out what it doesn't show. A
 * salary payment's status (`MySalaryPayment`) goes in `bills`.
 */
export interface PaymentStatuses {
  readonly bills?: readonly BillStatus[];
  readonly claims?: readonly ExpenseStatus[];
  readonly payrollRuns?: readonly PayrollRunStatus[];
  readonly floatMovements?: readonly FloatMovementPhase[];
  readonly payouts?: readonly PayoutStatus[];
}

const isAny = <T extends string>(
  statuses: readonly T[] | undefined,
  inFlight: readonly T[],
): boolean => statuses?.some((status) => inFlight.includes(status)) ?? false;

/** True while any of `statuses` is a payment on its way. */
export function isPaymentInFlight(statuses: PaymentStatuses): boolean {
  return (
    isAny(statuses.bills, IN_FLIGHT_BILL_STATUSES) ||
    isAny(statuses.claims, IN_FLIGHT_CLAIM_STATUSES) ||
    isAny(statuses.payrollRuns, IN_FLIGHT_PAYROLL_RUN_STATUSES) ||
    isAny(statuses.floatMovements, IN_FLIGHT_FLOAT_MOVEMENT_PHASES) ||
    isAny(statuses.payouts, IN_FLIGHT_PAYOUT_STATUSES)
  );
}

/**
 * A query's `refetchInterval`: every `PAYMENT_POLL_MS` while a payment it
 * shows is on its way, `false` once none is.
 */
export function paymentPollInterval(statuses: PaymentStatuses): number | false {
  return isPaymentInFlight(statuses) ? PAYMENT_POLL_MS : false;
}
