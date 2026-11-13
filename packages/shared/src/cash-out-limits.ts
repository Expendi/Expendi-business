import { z } from "zod";

import type { PayeeMethod } from "./payee.js";
import { formatKesAmount } from "./kes-amount.js";

/** The ways of paying a payee that send shillings as a cash-out. */
export const CASH_OUT_PAYEE_METHODS = [
  "mpesa_phone",
  "mpesa_till",
  "mpesa_paybill",
  "bank",
] as const satisfies readonly PayeeMethod[];

export function paysByCashOut(method: PayeeMethod | null): boolean {
  return (CASH_OUT_PAYEE_METHODS as readonly (PayeeMethod | null)[]).includes(
    method,
  );
}

const kesCents = z.string().regex(/^\d+$/);

/**
 * The smallest and largest amount one cash-out can send right now, in KES
 * cents. They can change at any time, so the server checks again when a
 * bill is saved and when it's paid. Null while a limit can't be worked out.
 */
export const cashOutAmountLimitsSchema = z.object({
  minKesCents: kesCents.nullable(),
  maxKesCents: kesCents.nullable(),
});

export type CashOutAmountLimitsResponse = z.infer<
  typeof cashOutAmountLimitsSchema
>;

export interface CashOutAmountLimits {
  readonly minKesCents: bigint | null;
  readonly maxKesCents: bigint | null;
}

/**
 * Why `amountKesCents` can't be sent as one cash-out within `limits`, or
 * null when it can. A cash-out sends whole shillings, rounding up, so the
 * amount is judged as it will be sent.
 */
export function cashOutAmountProblem(
  amountKesCents: bigint,
  limits: CashOutAmountLimits,
): string | null {
  const sent = ((amountKesCents + 99n) / 100n) * 100n;
  if (limits.maxKesCents !== null && sent > limits.maxKesCents) {
    return `A single payment can send at most ${formatKesAmount(limits.maxKesCents)}. Split it into smaller payments.`;
  }
  if (limits.minKesCents !== null && sent < limits.minKesCents) {
    const minimum = formatKesAmount(limits.minKesCents).replace(/\.00$/, "");
    return `The smallest amount that can be sent is ${minimum}.`;
  }
  return null;
}
